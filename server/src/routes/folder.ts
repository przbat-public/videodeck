import express from 'express';
import type { Response } from 'express';
import fs from 'fs/promises';
import path from 'path';
import type {
  ApiError,
  CancelAllResponse,
  CancelJobResponse,
  ChannelVideo,
  DownloadPlaylistResponse,
  DownloadVideoEvent,
  EnqueueJobsResponse,
  FolderConfig,
  FolderListResponse,
  ListExistsResponse,
  QueueJob,
  QueueListResponse,
  RebuildIndexResponse,
  SaveFolderConfigResponse,
  SkippedVideo,
  StatusResponse,
  VideoDownloadedResponse,
} from '@shared/api';
import { extractYoutubeVideoId } from '@shared/youtube';
import { getVideosFolderPaths } from '../config';
import {
  findEntryByVideoId,
  getDownloadStatuses,
  loadIndex,
  rebuildIndex,
} from '../services/folderIndex';
import { readListJson } from '../services/channelList';
import { buildPlaylistArgs, runYtDlp } from '../services/ytdlp';
import { downloadQueue } from '../services/downloadQueue';
import type { DownloadQueue } from '../services/downloadQueue';
import type { EnqueueRequest } from '../services/downloadQueue';
import {
  DEFAULT_DOWNLOAD_OPTIONS,
  invalidateCategoryCache,
  loadDownloadOptions,
  readFolderConfig,
  validateFolderConfig,
} from '../services/folderConfig';
import { stripUndefined } from '../utils/objectUtils';
import { errnoCode, readBody, readString, sendError } from './http';
import { configBodySchema, firstZodError, queueBodySchema } from './validation';
import type { NoParams, RouteHandler } from './http';
import { logger } from '../utils/logger';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve and authorize a folder path coming from the request.
 * Sends the proper error response and returns null when invalid.
 */
function requireAllowedFolder<Res>(value: unknown, res: Response<Res | ApiError>): string | null {
  const folderPath = readString(value);
  if (folderPath === undefined) {
    res.status(400).json({ error: 'folderPath is required' });
    return null;
  }
  if (!getVideosFolderPaths().includes(folderPath)) {
    res.status(403).json({ error: 'Folder path is not in the allowed list' });
    return null;
  }
  return folderPath;
}

/** Optional `folderPath` filter of the queue endpoints; false when malformed */
function readFolderFilter<Res>(
  value: unknown,
  res: Response<Res | ApiError>
): string | undefined | false {
  if (value !== undefined && typeof value !== 'string') {
    res.status(400).json({ error: 'folderPath must be a string' });
    return false;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Status / config
// ---------------------------------------------------------------------------

export type DownloadQueueLike = Pick<
  DownloadQueue,
  'enqueue' | 'list' | 'get' | 'cancel' | 'cancelAll' | 'on' | 'off'
>;

/**
 * The folder routes are a factory so the application can inject the download
 * queue (createApp options) instead of the handlers reaching for a module
 * singleton. Each call closes over its own queue instance.
 */
export function createFolderRouter(queue: DownloadQueueLike = downloadQueue): express.Router {
  const getStatus: RouteHandler<NoParams, StatusResponse> = async (_req, res) => {
    const videosFolderPaths = getVideosFolderPaths();
    // Configs live on an external disk: 56 folders read one after another
    // cost up to 3 s (the same reason categories are read in parallel).
    // readFolderConfig never throws, so the whole list is always built.
    const configs = await Promise.all(videosFolderPaths.map(readFolderConfig));
    const folderConfigs: Record<string, FolderConfig | null> = {};
    videosFolderPaths.forEach((folderPath, index) => {
      folderConfigs[folderPath] = configs[index] ?? null;
    });
    res.json({
      videosFolderPath: videosFolderPaths,
      folderConfigs,
      downloadDefaults: DEFAULT_DOWNLOAD_OPTIONS,
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
    await fs.writeFile(
      path.join(folderPath, 'config.json'),
      JSON.stringify(validConfig, null, 2),
      'utf-8'
    );
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
    const channelUrl = configuredUrl.endsWith('/videos')
      ? configuredUrl
      : `${configuredUrl}/videos`;

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
            { cause: parseError }
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
      const videoUrl = readString(video.videoUrl) ?? readString(video.url) ?? '';
      const videoId =
        readString(video.videoId) ?? (videoUrl ? extractYoutubeVideoId(videoUrl) : null);
      if (!videoId) {
        skipped.push({ videoId: '', reason: 'videoId or videoUrl is required' });
        continue;
      }
      const url = videoUrl || `https://www.youtube.com/watch?v=${videoId}`;
      const title = readString(video.title);
      if (type === 'update') {
        const entry = folderIndex?.entries[videoId];
        if (!entry) {
          skipped.push({ videoId, reason: 'not downloaded' });
          continue;
        }
        requests.push(
          stripUndefined<EnqueueRequest>({
            folderPath,
            videoId,
            videoUrl: url,
            title,
            type,
            baseName: entry.baseName,
            options,
          })
        );
      } else {
        requests.push(
          stripUndefined<EnqueueRequest>({
            folderPath,
            videoId,
            videoUrl: url,
            title,
            type,
            options,
          })
        );
      }
    }

    const jobs = requests.length > 0 ? queue.enqueue(requests) : [];
    res.status(202).json({ jobs, skipped });
  };

  const listJobs: RouteHandler<NoParams, QueueListResponse> = (req, res) => {
    const folderPath = readFolderFilter(req.query.folderPath, res);
    if (folderPath === false) return;
    res.json({ jobs: queue.list(folderPath) });
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
   * Single-video download with SSE progress (used by the Chrome extension).
   * The job runs in the server-side queue; closing the connection only stops
   * the event stream, not the download.
   */
  const downloadVideo: RouteHandler<NoParams, never> = async (req, res) => {
    try {
      const body = readBody(req);
      const folderPath = requireAllowedFolder(body.folderPath, res);
      if (!folderPath) return;
      const videoUrl = readString(body.videoUrl);
      if (videoUrl === undefined) {
        res.status(400).json({ error: 'videoUrl is required' });
        return;
      }

      await fs.mkdir(folderPath, { recursive: true });

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();

      const sendEvent = (event: DownloadVideoEvent) => {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      };

      const videoId = extractYoutubeVideoId(videoUrl) ?? videoUrl;
      const options = await loadDownloadOptions(folderPath);
      const [job] = queue.enqueue([{ folderPath, videoId, videoUrl, type: 'download', options }]);
      if (!job) {
        throw new Error('Queue did not return a job');
      }
      sendEvent({ type: 'start', message: 'Starting download...' });

      let seenLogCount = 0;
      let finished = false;

      const finish = (snapshot: QueueJob) => {
        if (finished) return;
        finished = true;
        queue.off('job', onJob);
        if (snapshot.status === 'done') {
          sendEvent({ type: 'done', message: 'Download completed successfully', done: true });
        } else {
          sendEvent({
            type: 'error',
            error: snapshot.error ?? `Download ${snapshot.status}`,
            done: true,
          });
        }
        res.end();
      };

      const onJob = (snapshot: QueueJob) => {
        if (snapshot.id !== job.id) return;
        // log is a bounded tail; use the running counter to find unsent lines
        const unsent = snapshot.logLineCount - seenLogCount;
        if (unsent > 0) {
          for (const line of snapshot.log.slice(-Math.min(unsent, snapshot.log.length))) {
            sendEvent({ type: 'output', message: `${line}\n` });
          }
        }
        seenLogCount = snapshot.logLineCount;
        if (
          snapshot.status === 'done' ||
          snapshot.status === 'error' ||
          snapshot.status === 'cancelled'
        ) {
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
  router.delete('/folder/queue/:jobId', cancelJob);
  router.post('/folder/download-video', downloadVideo);

  return router;
}
