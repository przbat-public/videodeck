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
  FolderSummariesResponse,
  FolderSummary,
  ListExistsResponse,
  QueueJob,
  QueueJobResponse,
  QueueListResponse,
  QueuePauseResponse,
  QueueSummaryResponse,
  RebuildIndexResponse,
  SaveFolderConfigResponse,
  SkippedVideo,
  StatusResponse,
  VideoDownloadedResponse,
} from '@videodeck/shared/api';
import { downloadVideoEventSchema } from '@videodeck/shared/schemas';
import { extractYoutubeVideoId, isYoutubeChannelUrl, isYoutubeVideoId, toWatchUrl } from '@videodeck/shared/youtube';
import type { Response } from 'express';
import express from 'express';
import { getVideosFolderPaths } from '../config';
import { sseStreamsOpen } from '../metrics';
import { ListJsonError, readListJson } from '../services/channelList';
import { readCollection } from '../services/collection';
import type { DownloadQueue, EnqueueRequest } from '../services/downloadQueue';
import { downloadQueue, toListJob } from '../services/downloadQueue';
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
import { summarizeFolder } from '../services/folderSummary';
import { buildPlaylistArgs, runYtDlp } from '../services/ytdlp';
import { writeJsonAtomic } from '../utils/fsUtils';
import { logger } from '../utils/logger';
import { stripUndefined } from '../utils/objectUtils';
import { runPool } from '../utils/runPool';
import { registerSseStream } from '../utils/sseRegistry';
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
  const allowed = getVideosFolderPaths().find((candidate) => normalizeFolderPath(candidate) === normalized);
  if (allowed === undefined) {
    logger.warn(`Rejected folderPath not in the allowed list: ${folderPath}`);
    res.status(403).json({ error: `Folder path is not in the allowed list: ${folderPath}` });
    return null;
  }
  // Hand back the configured entry, not the request value. The two strings
  // are equal by the comparison above, but only the configured one is
  // provably free of user input, which is what lets taint analysis (CodeQL
  // js/path-injection) treat this check as the sanitizer it is.
  return normalizeFolderPath(allowed);
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
  | 'enqueue'
  | 'list'
  | 'summary'
  | 'get'
  | 'cancel'
  | 'cancelAll'
  | 'whenPersisted'
  | 'on'
  | 'off'
  | 'setPaused'
  | 'isPaused'
  | 'clearFinished'
>;

/**
 * Jobs one unfiltered GET /api/folder/queue page returns. The console polls
 * /summaries instead, so this cap only bounds a direct or debugging read of a
 * queue that can hold thousands of jobs; `total` says what was left out.
 */
const QUEUE_LIST_LIMIT = 200;

/**
 * The folder routes are a factory so the application can inject the download
 * queue (createApp options) instead of the handlers reaching for a module
 * singleton. Each call closes over its own queue instance.
 */
/** 5 s cache of GET /api/status keyed by the expanded folder list */
const STATUS_CACHE_TTL_MS = 5_000;
let statusCache: { key: string; readAt: number; body: StatusResponse } | null = null;

function readStatusCache(folderPaths: string[]): StatusResponse | undefined {
  const cached = statusCache;
  if (cached === null || cached.key !== folderPaths.join('\n') || Date.now() - cached.readAt >= STATUS_CACHE_TTL_MS) {
    return undefined;
  }
  return cached.body;
}

function writeStatusCache(folderPaths: string[], body: StatusResponse): void {
  statusCache = { key: folderPaths.join('\n'), readAt: Date.now(), body };
}

/** Tests: drop the status cache */
export function invalidateStatusCache(): void {
  statusCache = null;
}

/** 5 s cache of GET /api/folder/summaries keyed by the expanded folder list */
const SUMMARY_CACHE_TTL_MS = 5_000;
/** Folders read at once: the console asks for every channel on one page load */
const SUMMARY_READ_CONCURRENCY = 8;
let summaryCache: { key: string; readAt: number; body: FolderSummariesResponse } | null = null;

function readSummaryCache(folderPaths: string[]): FolderSummariesResponse | undefined {
  const cached = summaryCache;
  if (cached === null || cached.key !== folderPaths.join('\n') || Date.now() - cached.readAt >= SUMMARY_CACHE_TTL_MS) {
    return undefined;
  }
  return cached.body;
}

function writeSummaryCache(folderPaths: string[], body: FolderSummariesResponse): void {
  summaryCache = { key: folderPaths.join('\n'), readAt: Date.now(), body };
}

/**
 * Replace one folder's counts in the cached answer, if there is one. A single
 * folder is read fresh right after its job finished; without this the next
 * full answer inside the cache window would roll the folder back.
 */
function patchSummaryCache(folderPath: string, summary: FolderSummary): void {
  if (summaryCache !== null) {
    summaryCache.body.summaries[folderPath] = summary;
  }
}

/** Counts of one folder; a folder that cannot be read reports zeroes */
async function summarizeOne(folderPath: string): Promise<FolderSummary> {
  try {
    // Read in parallel: nearly every folder is a channel, and the config read
    // must not add a disk round trip to each of them
    const [config, list, statuses] = await Promise.all([
      readFolderConfig(folderPath),
      readListJson(folderPath),
      getDownloadStatuses(folderPath),
    ]);
    if (config?.kind === 'collection') {
      const collection = await readCollection(folderPath);
      return summarizeFolder(collection.videos, collection);
    }
    return summarizeFolder(list, statuses);
  } catch (error) {
    logger.error(`Cannot summarize ${folderPath}:`, error);
    return { videos: 0, downloaded: 0, notDownloaded: 0, stale: 0 };
  }
}

/** Tests: drop the summaries cache */
export function invalidateSummaryCache(): void {
  summaryCache = null;
}

export function createFolderRouter(queue: DownloadQueueLike = downloadQueue): express.Router {
  const getStatus: RouteHandler<NoParams, StatusResponse> = async (_req, res) => {
    const videosFolderPaths = getVideosFolderPaths();

    // The status page polls this endpoint; building it reads every folder's
    // config.json plus one ES alias check per folder (up to ~3 s over
    // external disks). Serve a 5 s cache so a burst of page loads cannot
    // hammer the drives or Elasticsearch.
    const cached = readStatusCache(videosFolderPaths);
    if (cached !== undefined) {
      res.json(cached);
      return;
    }

    // Configs live on an external disk: 56 folders read one after another
    // cost up to 3 s (the same reason categories are read in parallel).
    // readFolderConfig never throws, so the whole list is always built.
    // Elasticsearch absence must not take the page down: the folder list, the
    // configs and list.json presence all come from disk. An unreachable cluster
    // reports no cached folders and says so, and the client hides the per-row
    // index chips instead of claiming every channel lost its index.
    const [configs, cachedLookup] = await Promise.all([
      Promise.all(videosFolderPaths.map(readFolderConfig)),
      listCachedFolders(videosFolderPaths).catch(() => null),
    ]);
    const elasticsearchUp = cachedLookup?.elasticsearchUp ?? false;
    // A partial read is not reported as an index state: either the cluster
    // answered for every folder, or the response says it is down and the client
    // hides the per-row chips.
    const indexedFolders = elasticsearchUp
      ? videosFolderPaths.filter((folderPath) => cachedLookup?.folders.has(folderPath) === true)
      : [];
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
    const body: StatusResponse = {
      videosFolderPath: videosFolderPaths,
      folderConfigs,
      downloadDefaults: DEFAULT_DOWNLOAD_OPTIONS,
      indexedFolders,
      listExists,
      elasticsearch: elasticsearchUp ? 'ok' : 'down',
      status: 'ok',
    };
    writeStatusCache(videosFolderPaths, body);
    res.json(body);
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
    await writeJsonAtomic(folderPath, 'config.json', validConfig);
    invalidateCategoryCache();
    invalidateStatusCache();
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
   * index (`.videos-index.json`) instead of parsing every info.json. A
   * collection has no list.json, so its list is the index itself.
   */
  const getFolderList: RouteHandler<NoParams, FolderListResponse> = async (req, res) => {
    const folderPath = requireAllowedFolder(req.query.folderPath, res);
    if (!folderPath) return;

    if ((await readFolderConfig(folderPath))?.kind === 'collection') {
      res.json(await readCollection(folderPath));
      return;
    }

    let videos: ChannelVideo[] | null;
    try {
      videos = await readListJson(folderPath);
    } catch (error) {
      if (error instanceof ListJsonError) {
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

  /**
   * Counts per channel for the download page's console: one request for every
   * configured folder instead of one per row. `list.json` and the folder index
   * are two reads per folder on disk, so the reads run through a pool and the
   * answer is cached for a few seconds; a folder that cannot be read reports
   * zeroes and never fails the whole response.
   *
   * With `?folderPath=` the answer holds that one folder, read fresh: the
   * console asks for it when a job of that folder finishes, so the counts
   * follow the downloads without re-reading every folder on every job.
   */
  const getFolderSummaries: RouteHandler<NoParams, FolderSummariesResponse> = async (req, res) => {
    if (req.query.folderPath !== undefined) {
      const folderPath = requireAllowedFolder(req.query.folderPath, res);
      if (!folderPath) return;
      const summary = await summarizeOne(folderPath);
      patchSummaryCache(folderPath, summary);
      res.json({ summaries: { [folderPath]: summary } });
      return;
    }

    const videosFolderPaths = getVideosFolderPaths();
    const cached = readSummaryCache(videosFolderPaths);
    if (cached !== undefined) {
      res.json(cached);
      return;
    }

    const summaries: FolderSummariesResponse['summaries'] = {};
    await runPool(videosFolderPaths, SUMMARY_READ_CONCURRENCY, async (folderPath) => {
      summaries[folderPath] = await summarizeOne(folderPath);
    });

    const body: FolderSummariesResponse = { summaries };
    writeSummaryCache(videosFolderPaths, body);
    res.json(body);
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
    // Defense in depth: the save path validates too, but a hand-edited
    // config.json bypasses it. The URL must be an https YouTube channel
    // before yt-dlp ever sees it — anything else is an SSRF/argument-
    // injection primitive.
    if (!isYoutubeChannelUrl(configuredUrl)) {
      res.status(400).json({
        error: 'channelUrl is not a YouTube channel URL',
        message:
          'Please set channelUrl to a YouTube channel URL (https://youtube.com/@handle, /channel/…, /c/…, /user/…)',
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
    await writeJsonAtomic(folderPath, 'list.json', entries);
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

  /**
   * The queue as a list. The log tail does not travel with it (a real instance
   * carried megabytes of log lines on a poll that renders none of them) and the
   * answer is capped: `total` says how many jobs the queue actually holds. The
   * console polls /summaries instead; this endpoint serves a filtered view and
   * API consumers. `?folderPath=` keeps every job of that one folder, because
   * the video rows read their own status from it.
   */
  const listJobs: RouteHandler<NoParams, QueueListResponse> = (req, res) => {
    const folderPath = readFolderFilter(req.query.folderPath, res);
    if (folderPath === false) return;
    const jobs = queue.list(folderPath);
    const page = folderPath === undefined ? jobs.slice(0, QUEUE_LIST_LIMIT) : jobs;
    res.json({ jobs: page.map(toListJob), total: jobs.length, paused: queue.isPaused() });
  };

  /** Counters plus the running jobs, without the list and without logs */
  const getQueueSummary: RouteHandler<NoParams, QueueSummaryResponse> = (_req, res) => {
    res.json({ ...queue.summary(), paused: queue.isPaused() });
  };

  /** One job with its full log tail — what the list deliberately leaves out */
  const getJob: RouteHandler<{ jobId: string }, QueueJobResponse> = (req, res) => {
    const job = queue.get(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    res.json({ job });
  };

  const setQueuePaused: RouteHandler<NoParams, QueuePauseResponse> = (req, res) => {
    const value = readString(req.query.paused);
    if (value !== '1' && value !== '0' && value !== 'true' && value !== 'false') {
      res.status(400).json({ error: 'paused must be 1 or 0' });
      return;
    }
    // The queue owns the flag (restore sets it at boot too) — read it back
    // instead of answering from a copy the router would have to keep in sync.
    queue.setPaused(value === '1' || value === 'true');
    res.json({ paused: queue.isPaused() });
  };

  const clearFinishedJobs: RouteHandler<NoParams, ClearFinishedResponse> = (_req, res) => {
    res.json({ cleared: queue.clearFinished() });
  };

  const cancelAllJobs: RouteHandler<NoParams, CancelAllResponse> = async (req, res) => {
    const folderPath = readFolderFilter(req.query.folderPath, res);
    if (folderPath === false) return;
    const cancelled = queue.cancelAll(folderPath);
    await queue.whenPersisted();
    res.json({ cancelled });
  };

  const cancelJob: RouteHandler<{ jobId: string }, CancelJobResponse> = async (req, res) => {
    const job = queue.get(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    const cancelled = queue.cancel(job.id);
    await queue.whenPersisted();
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
      // requireAllowedFolder already authorizes the folder; re-assert inline
      // so the guard sits on the same code path as the file operations below.
      const allowedFolders = getVideosFolderPaths().map(normalizeFolderPath);
      if (!allowedFolders.includes(request.folderPath)) {
        logger.warn(`Rejected folderPath not in the allowed list: ${request.folderPath}`);
        res.status(403).json({ error: `Folder path is not in the allowed list: ${request.folderPath}` });
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
      streamJobProgress(res, queue, job);
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
  router.get('/folder/summaries', getFolderSummaries);
  router.post('/folder/rebuild-index', rebuildFolderIndex);
  router.post('/folder/download-playlist', downloadPlaylist);
  router.get('/folder/video-downloaded', isVideoDownloaded);
  router.post('/folder/queue', enqueueJobs);
  router.get('/folder/queue', listJobs);
  router.delete('/folder/queue', cancelAllJobs);
  // registered before /:jobId so "summaries" is not read as a job id
  router.get('/folder/queue/summaries', getQueueSummary);
  router.get('/folder/queue/:jobId', getJob);
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
function streamJobProgress(res: Response, queue: DownloadQueueLike, job: QueueJob): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Track the stream so graceful shutdown can end it and let server.close()
  // finish instead of waiting on the keep-alive connection.
  const unregister = registerSseStream(res);
  sseStreamsOpen.inc();

  // Every event is validated against the shared contract before it reaches
  // the wire: a malformed event would corrupt the client's stream parser.
  const sendEvent = (event: DownloadVideoEvent) => {
    const parsed = downloadVideoEventSchema.safeParse(event);
    if (!parsed.success) {
      logger.warn(`Dropping invalid SSE event ${JSON.stringify(event)}: ${firstZodError(parsed.error)}`);
      return;
    }
    res.write(`data: ${JSON.stringify(parsed.data)}\n\n`);
  };

  sendEvent({ type: 'downloadStart' });

  let seenLogCount = 0;
  let finished = false;
  let cleanedUp = false;

  // SSE comment lines keep the connection alive during quiet merge phases
  // without being parsed as events — the extension's service worker depends
  // on that traffic to stay awake. Cleared when the stream closes.
  const heartbeat = setInterval(() => {
    if (!finished) {
      res.write(': ping\n\n');
    }
  }, 15_000);

  /**
   * Release everything the stream holds. Idempotent: a finished job ends the
   * response and the client disconnect that follows emits the same 'close'
   * event, and either order must decrement the gauge exactly once.
   */
  const cleanup = () => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    finished = true;
    clearInterval(heartbeat);
    unregister();
    queue.off('job', onJob);
    queue.off('progress', onProgress);
    sseStreamsOpen.dec();
  };

  const finish = (snapshot: QueueJob) => {
    if (finished) {
      return;
    }
    finished = true;
    sendEvent(
      snapshot.status === 'done'
        ? { type: 'downloadComplete', message: 'Download completed successfully' }
        : { type: 'downloadError', error: snapshot.error ?? `Download ${snapshot.status}` },
    );
    res.end();
    cleanup();
  };

  const onJob = (snapshot: QueueJob) => {
    if (snapshot.id !== job.id) {
      return;
    }
    // log is a bounded tail; use the running counter to find unsent lines
    const unsent = snapshot.logLineCount - seenLogCount;
    if (unsent > 0) {
      for (const line of snapshot.log.slice(-Math.min(unsent, snapshot.log.length))) {
        sendEvent({ type: 'downloadProgress', progress: snapshot.progress, message: `${line}\n` });
      }
    }
    seenLogCount = snapshot.logLineCount;
    if (snapshot.status === 'done' || snapshot.status === 'error' || snapshot.status === 'cancelled') {
      finish(snapshot);
    }
  };

  // Progress lines are parsed and dropped from the log, so a separate tick
  // carries the percentage the extension's progress bar animates on.
  const onProgress = (snapshot: QueueJob) => {
    if (snapshot.id !== job.id || finished) {
      return;
    }
    sendEvent({
      type: 'downloadProgress',
      progress: snapshot.progress,
      message: `Progress: ${Math.round(snapshot.progress ?? 0)}%`,
    });
  };

  queue.on('job', onJob);
  queue.on('progress', onProgress);

  // Job may already be finished (deduped against a completed one is not
  // possible, but a very fast failure is) — replay current state.
  const current = queue.get(job.id);
  if (current) {
    onJob(current);
  }

  // The response, not the request: since Node 16 the request's 'close' fires
  // once its body has been consumed, not when the client goes away, so an
  // aborted download kept the heartbeat interval and both queue listeners
  // alive until the job happened to settle. The download itself still runs
  // server-side; only the stream is released.
  res.on('close', cleanup);
}
