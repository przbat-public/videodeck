import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  ApiError,
  CancelAllResponse,
  CancelJobResponse,
  ChannelVideo,
  ClearFinishedResponse,
  DownloadOptions,
  DownloadPlaylistResponse,
  DownloadVideoEvent,
  EnqueueJobsResponse,
  FolderConfig,
  FolderListResponse,
  ListExistsResponse,
  QueueJob,
  QueueListResponse,
  QueuePauseResponse,
  RebuildIndexResponse,
  SaveFolderConfigResponse,
  SkippedVideo,
  StatusResponse,
  VideoDownloadedResponse,
} from '@shared/api';
import { extractYoutubeVideoId, isYoutubeVideoId, toWatchUrl } from '@shared/youtube';
import type { Response } from 'express';
import express from 'express';
import { getVideosFolderPaths } from '../config';
import { readListJson } from '../services/channelList';
import type { DownloadQueue, EnqueueRequest } from '../services/downloadQueue';
import { downloadQueue } from '../services/downloadQueue';
import { listCachedFolders } from '../services/elasticsearchService';
import {
  DEFAULT_DOWNLOAD_OPTIONS,
  invalidateCategoryCache,
  loadDownloadOptions,
  readFolderConfig,
  validateFolderConfig,
} from '../services/folderConfig';
import type { FolderIndex } from '../services/folderIndex';
import { findEntryByVideoId, getDownloadStatuses, loadIndex, rebuildIndex } from '../services/folderIndex';
import { buildPlaylistArgs, runYtDlp } from '../services/ytdlp';
import { logger } from '../utils/logger';
import { stripUndefined } from '../utils/objectUtils';
import { normalizeFolderPath } from '../utils/videoPathUtils';
import type { NoParams, RouteHandler } from './http';
import { errnoCode, readBody, readString, sendError } from './http';
import { configBodySchema, firstZodError, queueBodySchema } from './validation';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve and authorize a folder path coming from the request.
 * `~/` and trailing slashes are normalized before the comparison, so a
 * hand-typed extension option matches the configured list. Sends the proper
 * error response (echoing the received value) and returns null when invalid.
 */
function requireAllowedFolder<Res>(value: unknown, res: Response<Res | ApiError>): string | null {
  const folderPath = readString(value);
  if (folderPath === undefined) {
    res.status(400).json({ error: 'folderPath is required' });
    return null;
  }
  const normalized = normalizeFolderPath(folderPath);
  if (!getVideosFolderPaths().some((allowed) => normalizeFolderPath(allowed) === normalized)) {
    logger.warn(`Rejected folderPath not in the allowed list: ${folderPath}`);
    res.status(403).json({ error: `Folder path is not in the allowed list: ${folderPath}` });
    return null;
  }
  return normalized;
}

/** Optional `folderPath` filter of the queue endpoints; false when malformed */
function readFolderFilter<Res>(value: unknown, res: Response<Res | ApiError>): string | undefined | false {
  if (value !== undefined && typeof value !== 'string') {
    res.status(400).json({ error: 'folderPath must be a string' });
    return false;
  }
  return value;
}

/** One entry of a parsed queue body (see queueBodySchema) */
type QueueVideoInput = {
  videoId?: string | undefined;
  videoUrl?: string | undefined;
  url?: string | undefined;
  title?: string | undefined;
};

type QueueVideoOutcome = { request: EnqueueRequest } | { skipped: SkippedVideo };

/**
 * Validate one queue entry and turn it into an enqueue request or a skip
 * reason. SSRF guard: the URL only ever reaches yt-dlp as a canonical
 * YouTube watch URL — a URL that is not YouTube (or not even a URL) is
 * refused, never passed through raw (yt-dlp would fetch arbitrary targets).
 */
function toEnqueueRequest(
  video: QueueVideoInput,
  type: 'download' | 'update',
  folderPath: string,
  options: DownloadOptions,
  folderIndex: FolderIndex | null,
): QueueVideoOutcome {
  const videoUrl = readString(video.videoUrl) ?? readString(video.url) ?? '';
  const extractedId = videoUrl ? extractYoutubeVideoId(videoUrl) : null;
  if (videoUrl && !extractedId) {
    return { skipped: { videoId: '', reason: 'videoUrl must be a YouTube video URL' } };
  }
  const videoId = readString(video.videoId) ?? extractedId;
  if (!videoId) {
    return { skipped: { videoId: '', reason: 'videoId or videoUrl is required' } };
  }
  if (!isYoutubeVideoId(videoId)) {
    return { skipped: { videoId, reason: 'videoId is not a valid YouTube video id' } };
  }
  // A watch URL carrying &list=&index= makes yt-dlp walk the whole playlist
  // from that point — always hand it a canonical single-video URL
  const url = toWatchUrl(videoId);
  const title = readString(video.title);
  if (type === 'update') {
    const entry = folderIndex?.entries[videoId];
    if (!entry) {
      return { skipped: { videoId, reason: 'not downloaded' } };
    }
    return {
      request: stripUndefined<EnqueueRequest>({
        folderPath,
        videoId,
        videoUrl: url,
        title,
        type,
        baseName: entry.baseName,
        options,
      }),
    };
  }
  return {
    request: stripUndefined<EnqueueRequest>({ folderPath, videoId, videoUrl: url, title, type, options }),
  };
}

// ---------------------------------------------------------------------------
// Status / config
// ---------------------------------------------------------------------------

export type DownloadQueueLike = Pick<
  DownloadQueue,
  'enqueue' | 'list' | 'get' | 'cancel' | 'cancelAll' | 'on' | 'off' | 'setPaused' | 'clearFinished'
>;

/**
 * The folder routes are a factory so the application can inject the download
 * queue (createApp options) instead of the handlers reaching for a module
 * singleton. Each call closes over its own queue instance.
 */
export function createFolderRouter(queue: DownloadQueueLike = downloadQueue): express.Router {
  // Paused state is mirrored here so listJobs can report it (the injected
  // queue only exposes setPaused)
  let queueIsPaused = false;

  const getStatus: RouteHandler<NoParams, StatusResponse> = async (_req, res) => {
    const videosFolderPaths = getVideosFolderPaths();
    // Configs live on an external disk: 56 folders read one after another
    // cost up to 3 s (the same reason categories are read in parallel).
    // readFolderConfig never throws, so the whole list is always built.
    const [configs, cachedFolders] = await Promise.all([
      Promise.all(videosFolderPaths.map(readFolderConfig)),
      listCachedFolders(videosFolderPaths),
    ]);
    const folderConfigs: Record<string, FolderConfig | null> = {};
    videosFolderPaths.forEach((folderPath, index) => {
      folderConfigs[folderPath] = configs[index] ?? null;
    });
    // list.json presence for every folder in one batched pass — the client
    // used to ask per folder (57 requests on a full status page)
    const listExists: Record<string, boolean> = {};
    await Promise.all(
      videosFolderPaths.map(async (folderPath) => {
        try {
          await fs.access(path.join(folderPath, 'list.json'));
          listExists[folderPath] = true;
        } catch {
          listExists[folderPath] = false;
        }
      }),
    );
    res.json({
      videosFolderPath: videosFolderPaths,
      folderConfigs,
      downloadDefaults: DEFAULT_DOWNLOAD_OPTIONS,
      indexedFolders: videosFolderPaths.filter((folderPath) => cachedFolders.has(folderPath)),
      listExists,
      status: 'ok',
    });
  };

  const saveFolderConfig: RouteHandler<NoParams, SaveFolderConfigResponse> = async (req, res) => {
    const parsed = configBodySchema.safeParse(readBody(req));
    if (!parsed.success) {
      res.status(400).json({ error: firstZodError(parsed.error) });
      return;
    }
    const { folderPath: rawFolderPath, config } = parsed.data;

    const validationError = validateFolderConfig(config);
    if (validationError !== null) {
      res.status(400).json({ error: validationError });
      return;
    }
    // validateFolderConfig accepted it, so `config` is a plain object
    const validConfig: FolderConfig = { ...(config as FolderConfig) };
    if (typeof validConfig.category === 'string') {
      // Stored trimmed so the file matches what search compares against
      validConfig.category = validConfig.category.trim();
    }
    const folderPath = requireAllowedFolder(rawFolderPath, res);
    if (!folderPath) return;

    await fs.mkdir(folderPath, { recursive: true });
    await fs.writeFile(path.join(folderPath, 'config.json'), JSON.stringify(validConfig, null, 2), 'utf-8');
    invalidateCategoryCache();
    res.json({ success: true, config: validConfig });
  };

  // ---------------------------------------------------------------------------
  // list.json
  // ---------------------------------------------------------------------------

  const listExists: RouteHandler<NoParams, ListExistsResponse> = async (req, res) => {
    const folderPath = requireAllowedFolder(req.query.folderPath, res);
    if (!folderPath) return;

    try {
      await fs.access(path.join(folderPath, 'list.json'));
      res.json({ exists: true });
    } catch (error) {
      if (errnoCode(error) === 'ENOENT') {
        res.json({ exists: false });
        return;
      }
      throw error;
    }
  };

  /**
   * list.json content plus download statuses. Statuses come from the folder
   * index (`.videos-index.json`) instead of parsing every info.json.
   */
  const getFolderList: RouteHandler<NoParams, FolderListResponse> = async (req, res) => {
    const folderPath = requireAllowedFolder(req.query.folderPath, res);
    if (!folderPath) return;

    let videos: ChannelVideo[] | null;
    try {
      videos = await readListJson(folderPath);
    } catch (error) {
      if (error instanceof Error && error.message === 'list.json is not a valid array') {
        res.status(400).json({ error: error.message });
        return;
      }
      throw error;
    }
    if (!videos) {
      res.status(404).json({ error: 'list.json not found' });
      return;
    }

    let downloadStatuses: Record<string, boolean> = {};
    let lastUpdatedDates: Record<string, string> = {};
    try {
      ({ downloadStatuses, lastUpdatedDates } = await getDownloadStatuses(folderPath));
    } catch (error) {
      // Folder unreadable — treat everything as not downloaded
      logger.error(`Error loading folder index for ${folderPath}:`, error);
    }

    res.json({ videos, downloadStatuses, lastUpdatedDates });
  };

  const rebuildFolderIndex: RouteHandler<NoParams, RebuildIndexResponse> = async (req, res) => {
    const folderPath = requireAllowedFolder(readBody(req).folderPath, res);
    if (!folderPath) return;

    const index = await rebuildIndex(folderPath);
    res.json({ success: true, count: Object.keys(index.entries).length, builtAt: index.builtAt });
  };

  /**
   * Fetch the channel's video list with `yt-dlp --flat-playlist -j` and store
   * it as a JSON array in list.json.
   */
  const downloadPlaylist: RouteHandler<NoParams, DownloadPlaylistResponse> = async (req, res) => {
    const folderPath = requireAllowedFolder(readBody(req).folderPath, res);
    if (!folderPath) return;

    const config = await readFolderConfig(folderPath);
    if (!config) {
      res.status(404).json({
        error: 'config.json not found',
        message: 'Please create config.json file with channelUrl first',
      });
      return;
    }
    const configuredUrl = readString(config.channelUrl);
    if (configuredUrl === undefined) {
      res.status(400).json({
        error: 'channelUrl is not configured',
        message: 'Please set channelUrl in config.json file',
      });
      return;
    }

    await fs.mkdir(folderPath, { recursive: true });
    const channelUrl = configuredUrl.endsWith('/videos') ? configuredUrl : `${configuredUrl}/videos`;

    let stdout: string;
    try {
      stdout = await runYtDlp(buildPlaylistArgs(channelUrl), folderPath);
    } catch (execError) {
      logger.error('Error executing yt-dlp:', execError);
      sendError(res, 500, 'Failed to download playlist', execError);
      return;
    }

    const entries: unknown[] = stdout
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line): unknown => {
        try {
          return JSON.parse(line);
        } catch (parseError) {
          logger.error('Error parsing JSON line:', line.substring(0, 100));
          throw new Error(
            `Failed to parse JSON line: ${parseError instanceof Error ? parseError.message : 'Unknown error'}`,
            { cause: parseError },
          );
        }
      });

    const listPath = path.join(folderPath, 'list.json');
    await fs.writeFile(listPath, JSON.stringify(entries, null, 2), 'utf-8');
    res.json({
      success: true,
      message: 'Playlist downloaded successfully',
      listPath,
      videoCount: entries.length,
    });
  };

  // ---------------------------------------------------------------------------
  // Download status / queue
  // ---------------------------------------------------------------------------

  const isVideoDownloaded: RouteHandler<NoParams, VideoDownloadedResponse> = async (req, res) => {
    const folderPath = requireAllowedFolder(req.query.folderPath, res);
    if (!folderPath) return;
    const videoId = readString(req.query.videoId);
    if (videoId === undefined) {
      res.status(400).json({ error: 'videoId is required' });
      return;
    }

    try {
      const entry = await findEntryByVideoId(folderPath, videoId);
      res.json({ downloaded: entry !== null });
    } catch (error) {
      if (errnoCode(error) === 'ENOENT') {
        res.json({ downloaded: false });
        return;
      }
      throw error;
    }
  };

  /**
   * Enqueue download/update jobs for one or more videos of a folder.
   * Body: { folderPath, type: 'download' | 'update', videos: [{ videoId, videoUrl, title }] }
   * `update` jobs require the video to be already downloaded (the existing file
   * stem is reused); others are reported in `skipped`.
   */
  const enqueueJobs: RouteHandler<NoParams, EnqueueJobsResponse> = async (req, res) => {
    const body = readBody(req);
    // Authorization first: an unknown folder is a 403 whatever the body looks like
    const folderPath = requireAllowedFolder(body.folderPath, res);
    if (!folderPath) return;

    const parsed = queueBodySchema.safeParse(body);
    if (!parsed.success) {
      res.status(400).json({ error: firstZodError(parsed.error) });
      return;
    }
    const { type, videos } = parsed.data;

    await fs.mkdir(folderPath, { recursive: true });
    const options = await loadDownloadOptions(folderPath);

    // Update jobs check every video against the folder index — loading it once
    // here instead of per video turns O(n) file reads into one plus in-memory
    // lookups (channels have thousands of videos).
    const folderIndex = type === 'update' ? await loadIndex(folderPath) : null;

    const requests: EnqueueRequest[] = [];
    const skipped: SkippedVideo[] = [];
    for (const video of videos) {
      const outcome = toEnqueueRequest(video, type, folderPath, options, folderIndex);
      if ('request' in outcome) {
        requests.push(outcome.request);
      } else {
        skipped.push(outcome.skipped);
      }
    }

    const jobs = requests.length > 0 ? queue.enqueue(requests) : [];
    res.status(202).json({ jobs, skipped });
  };

  const listJobs: RouteHandler<NoParams, QueueListResponse> = (req, res) => {
    const folderPath = readFolderFilter(req.query.folderPath, res);
    if (folderPath === false) return;
    res.json({ jobs: queue.list(folderPath), paused: queueIsPaused });
  };

  const setQueuePaused: RouteHandler<NoParams, QueuePauseResponse> = (req, res) => {
    const value = readString(req.query.paused);
    if (value !== '1' && value !== '0' && value !== 'true' && value !== 'false') {
      res.status(400).json({ error: 'paused must be 1 or 0' });
      return;
    }
    queueIsPaused = value === '1' || value === 'true';
    queue.setPaused(queueIsPaused);
    res.json({ paused: queueIsPaused });
  };

  const clearFinishedJobs: RouteHandler<NoParams, ClearFinishedResponse> = (_req, res) => {
    res.json({ cleared: queue.clearFinished() });
  };

  const cancelAllJobs: RouteHandler<NoParams, CancelAllResponse> = (req, res) => {
    const folderPath = readFolderFilter(req.query.folderPath, res);
    if (folderPath === false) return;
    res.json({ cancelled: queue.cancelAll(folderPath) });
  };

  const cancelJob: RouteHandler<{ jobId: string }, CancelJobResponse> = (req, res) => {
    const job = queue.get(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    const cancelled = queue.cancel(job.id);
    res.json(stripUndefined<CancelJobResponse>({ cancelled, job: queue.get(job.id) }));
  };

  /**
   * Validate the single-video download request (SSE endpoint). Sends the
   * proper error response and returns null when the request is not accepted.
   */
  function readDownloadVideoRequest<Res>(
    req: { body: unknown },
    res: Response<Res | ApiError>,
  ): { folderPath: string; videoId: string } | null {
    const body = readBody(req);
    const folderPath = requireAllowedFolder(body.folderPath, res);
    if (!folderPath) {
      return null;
    }
    const videoUrl = readString(body.videoUrl);
    if (videoUrl === undefined) {
      res.status(400).json({ error: 'videoUrl is required' });
      return null;
    }
    // SSRF guard: only canonical YouTube watch URLs reach the queue.
    const extractedId = extractYoutubeVideoId(videoUrl);
    if (!extractedId) {
      res.status(400).json({ error: 'videoUrl must be a YouTube video URL' });
      return null;
    }
    return { folderPath, videoId: extractedId };
  }

  /**
   * Single-video download with SSE progress (used by the Chrome extension).
   * The job runs in the server-side queue; closing the connection only stops
   * the event stream, not the download.
   */
  const downloadVideo: RouteHandler<NoParams, never> = async (req, res) => {
    try {
      const request = readDownloadVideoRequest(req, res);
      if (!request) {
        return;
      }
      await fs.mkdir(request.folderPath, { recursive: true });

      // Strip playlist context (&list=, &index=) — see the comment in
      // enqueueJobs.
      const options = await loadDownloadOptions(request.folderPath);
      const [job] = queue.enqueue([
        {
          folderPath: request.folderPath,
          videoId: request.videoId,
          videoUrl: toWatchUrl(request.videoId),
          type: 'download',
          options,
        },
      ]);
      if (!job) {
        throw new Error('Queue did not return a job');
      }
      streamJobProgress(req, res, queue, job);
    } catch (error) {
      if (!res.headersSent) {
        sendError(res, 500, 'Failed to start video download', error);
      } else {
        res.end();
      }
    }
  };

  // ---------------------------------------------------------------------------
  // Routes
  // ---------------------------------------------------------------------------

  const router = express.Router();

  router.get('/status', getStatus);
  router.put('/folder/config', saveFolderConfig);
  router.get('/folder/list-exists', listExists);
  router.get('/folder/list', getFolderList);
  router.post('/folder/rebuild-index', rebuildFolderIndex);
  router.post('/folder/download-playlist', downloadPlaylist);
  router.get('/folder/video-downloaded', isVideoDownloaded);
  router.post('/folder/queue', enqueueJobs);
  router.get('/folder/queue', listJobs);
  router.delete('/folder/queue', cancelAllJobs);
  router.post('/folder/queue/pause', setQueuePaused);
  router.post('/folder/queue/resume', setQueuePaused);
  // registered before /:jobId so "finished" is not read as a job id
  router.delete('/folder/queue/finished', clearFinishedJobs);
  router.delete('/folder/queue/:jobId', cancelJob);
  router.post('/folder/download-video', downloadVideo);

  return router;
}

/**
 * Stream one queue job as Server-Sent Events until it settles (done, error,
 * cancelled) or the client disconnects. The job keeps running server-side
 * either way — closing the stream never cancels the download.
 */
function streamJobProgress(
  req: { on(event: 'close', listener: () => void): void },
  res: Response,
  queue: DownloadQueueLike,
  job: QueueJob,
): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const sendEvent = (event: DownloadVideoEvent) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  sendEvent({ type: 'start', message: 'Starting download...' });

  let seenLogCount = 0;
  let finished = false;

  const finish = (snapshot: QueueJob) => {
    if (finished) {
      return;
    }
    finished = true;
    queue.off('job', onJob);
    sendEvent(
      snapshot.status === 'done'
        ? { type: 'done', message: 'Download completed successfully', done: true }
        : { type: 'error', error: snapshot.error ?? `Download ${snapshot.status}`, done: true },
    );
    res.end();
  };

  const onJob = (snapshot: QueueJob) => {
    if (snapshot.id !== job.id) {
      return;
    }
    // log is a bounded tail; use the running counter to find unsent lines
    const unsent = snapshot.logLineCount - seenLogCount;
    if (unsent > 0) {
      for (const line of snapshot.log.slice(-Math.min(unsent, snapshot.log.length))) {
        sendEvent({ type: 'output', message: `${line}\n` });
      }
    }
    seenLogCount = snapshot.logLineCount;
    if (snapshot.status === 'done' || snapshot.status === 'error' || snapshot.status === 'cancelled') {
      finish(snapshot);
    }
  };

  queue.on('job', onJob);

  // Job may already be finished (deduped against a completed one is not
  // possible, but a very fast failure is) — replay current state.
  const current = queue.get(job.id);
  if (current) {
    onJob(current);
  }

  req.on('close', () => {
    finished = true;
    queue.off('job', onJob);
  });
}
