import fs from 'node:fs/promises';
import type {
  ApiError,
  CancelAllResponse,
  CancelJobResponse,
  ClearFinishedResponse,
  DownloadOptions,
  EnqueueJobsResponse,
  QueueJobResponse,
  QueueListResponse,
  QueuePauseResponse,
  QueueSummaryResponse,
  SkippedVideo,
  VideoDownloadedResponse,
} from '@videodeck/shared/api';
import { extractYoutubeVideoId, isYoutubeVideoId, toWatchUrl } from '@videodeck/shared/youtube';
import type { Response } from 'express';
import type { DownloadQueue, EnqueueRequest } from '../../services/downloadQueue';
import { toListJob } from '../../services/downloadQueue';
import { loadDownloadOptions } from '../../services/folderConfig';
import type { FolderIndex } from '../../services/folderIndex';
import { findEntryByVideoId, loadIndex } from '../../services/folderIndex';
import { stripUndefined } from '../../utils/objectUtils';
import type { NoParams, RouteHandler } from '../http';
import { errnoCode, readBody, readString } from '../http';
import { firstZodError, queueBodySchema } from '../validation';
import { requireAllowedFolder } from './guards';

/**
 * The queue endpoints: the injected queue as a REST surface.
 *
 * Every handler is built per `createFolderRouter` call and closes over the
 * queue that call received, which is how `createApp` swaps the singleton for a
 * test double. Nothing here holds state of its own; the queue owns the jobs,
 * the pause flag and the log tails, and the router reads them back rather than
 * caching a copy.
 */

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

/** The handlers bound to one queue instance */
export function createQueueHandlers(queue: DownloadQueueLike) {
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

  return {
    isVideoDownloaded,
    enqueueJobs,
    listJobs,
    getQueueSummary,
    getJob,
    setQueuePaused,
    clearFinishedJobs,
    cancelAllJobs,
    cancelJob,
  };
}
