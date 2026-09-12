import express from 'express';
import type { Response } from 'express';
import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
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
  JobType,
  ListExistsResponse,
  QueueJob,
  QueueListResponse,
  QueueVideoInput,
  RebuildIndexResponse,
  SaveFolderConfigResponse,
  SkippedVideo,
  StatusResponse,
  VideoDownloadedResponse,
} from '@shared/api';
import { getVideosFolderPaths } from '../config';
import { findEntryByVideoId, getDownloadStatuses, rebuildIndex } from '../services/folderIndex';
import { downloadQueue } from '../services/downloadQueue';
import type { EnqueueRequest } from '../services/downloadQueue';
import {
  DEFAULT_DOWNLOAD_OPTIONS,
  invalidateCategoryCache,
  loadDownloadOptions,
  readFolderConfig,
  validateFolderConfig,
} from '../services/folderConfig';
import { stripUndefined } from '../utils/objectUtils';
import { errnoCode, isRecord, readBody, readString, sendError } from './http';
import type { NoParams, RouteHandler } from './http';

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

function toChannelVideo(entry: unknown): ChannelVideo {
  const record = isRecord(entry) ? entry : {};
  return {
    title: readString(record.title) ?? '',
    url: readString(record.url) ?? readString(record.webpage_url) ?? '',
    id: readString(record.id) ?? '',
  };
}

async function readListJson(folderPath: string): Promise<ChannelVideo[] | null> {
  const listPath = path.join(folderPath, 'list.json');
  let raw: string;
  try {
    raw = await fs.readFile(listPath, 'utf-8');
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') {
      return null;
    }
    throw error;
  }
  const data: unknown = JSON.parse(raw);
  if (!Array.isArray(data)) {
    throw new Error('list.json is not a valid array');
  }
  return data.map(toChannelVideo);
}

/**
 * Extract the YouTube id from common URL shapes; falls back to null.
 */
export function extractYoutubeVideoId(url: string): string | null {
  try {
    const parsed = new URL(url);
    const v = parsed.searchParams.get('v');
    if (v) {
      return v;
    }
    const host = parsed.hostname.replace(/^www\./, '');
    const segments = parsed.pathname.split('/').filter(Boolean);
    const [first] = segments;
    if (host === 'youtu.be' && first) {
      return first;
    }
    const marker = segments.findIndex(
      (s) => s === 'shorts' || s === 'embed' || s === 'live' || s === 'v'
    );
    return (marker >= 0 && segments[marker + 1]) || null;
  } catch {
    return null;
  }
}

function runYtDlp(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('yt-dlp', args, { cwd });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(out).toString('utf-8'));
      } else {
        reject(
          new Error(
            `yt-dlp exited with code ${code}: ${Buffer.concat(err).toString('utf-8').trim()}`
          )
        );
      }
    });
  });
}

function isJobType(value: unknown): value is JobType {
  return value === 'download' || value === 'update';
}

function isQueueVideoInput(value: unknown): value is QueueVideoInput {
  return isRecord(value);
}

// ---------------------------------------------------------------------------
// Status / config
// ---------------------------------------------------------------------------

const getStatus: RouteHandler<NoParams, StatusResponse> = async (_req, res) => {
  try {
    const videosFolderPaths = getVideosFolderPaths();
    const folderConfigs: Record<string, FolderConfig | null> = {};
    for (const folderPath of videosFolderPaths) {
      folderConfigs[folderPath] = await readFolderConfig(folderPath);
    }
    res.json({
      videosFolderPath: videosFolderPaths,
      folderConfigs,
      downloadDefaults: DEFAULT_DOWNLOAD_OPTIONS,
      status: 'ok',
    });
  } catch (error) {
    sendError(res, 500, 'Failed to get status', error);
  }
};

const saveFolderConfig: RouteHandler<NoParams, SaveFolderConfigResponse> = async (req, res) => {
  try {
    const { folderPath: rawFolderPath, config } = readBody(req);
    if (readString(rawFolderPath) === undefined) {
      res.status(400).json({ error: 'folderPath is required' });
      return;
    }
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
  } catch (error) {
    sendError(res, 500, 'Failed to save folder config', error);
  }
};

// ---------------------------------------------------------------------------
// list.json
// ---------------------------------------------------------------------------

const listExists: RouteHandler<NoParams, ListExistsResponse> = async (req, res) => {
  try {
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
  } catch (error) {
    sendError(res, 500, 'Failed to check list.json', error);
  }
};

/**
 * list.json content plus download statuses. Statuses come from the folder
 * index (`.videos-index.json`) instead of parsing every info.json.
 */
const getFolderList: RouteHandler<NoParams, FolderListResponse> = async (req, res) => {
  try {
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
      console.error(`Error loading folder index for ${folderPath}:`, error);
    }

    res.json({ videos, downloadStatuses, lastUpdatedDates });
  } catch (error) {
    sendError(res, 500, 'Failed to read list.json', error);
  }
};

const rebuildFolderIndex: RouteHandler<NoParams, RebuildIndexResponse> = async (req, res) => {
  try {
    const folderPath = requireAllowedFolder(readBody(req).folderPath, res);
    if (!folderPath) return;

    const index = await rebuildIndex(folderPath);
    res.json({ success: true, count: Object.keys(index.entries).length, builtAt: index.builtAt });
  } catch (error) {
    sendError(res, 500, 'Failed to rebuild folder index', error);
  }
};

/**
 * Fetch the channel's video list with `yt-dlp --flat-playlist -j` and store
 * it as a JSON array in list.json.
 */
const downloadPlaylist: RouteHandler<NoParams, DownloadPlaylistResponse> = async (req, res) => {
  try {
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
      stdout = await runYtDlp(['--flat-playlist', '-j', channelUrl], folderPath);
    } catch (execError) {
      console.error('Error executing yt-dlp:', execError);
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
          console.error('Error parsing JSON line:', line.substring(0, 100));
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
  } catch (error) {
    sendError(res, 500, 'Failed to download playlist', error);
  }
};

// ---------------------------------------------------------------------------
// Download status / queue
// ---------------------------------------------------------------------------

const isVideoDownloaded: RouteHandler<NoParams, VideoDownloadedResponse> = async (req, res) => {
  try {
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
  } catch (error) {
    sendError(res, 500, 'Failed to check video download status', error);
  }
};

/**
 * Enqueue download/update jobs for one or more videos of a folder.
 * Body: { folderPath, type: 'download' | 'update', videos: [{ videoId, videoUrl, title }] }
 * `update` jobs require the video to be already downloaded (the existing file
 * stem is reused); others are reported in `skipped`.
 */
const enqueueJobs: RouteHandler<NoParams, EnqueueJobsResponse> = async (req, res) => {
  try {
    const body = readBody(req);
    const folderPath = requireAllowedFolder(body.folderPath, res);
    if (!folderPath) return;

    const { type, videos } = body;
    if (!isJobType(type)) {
      res.status(400).json({ error: "type must be 'download' or 'update'" });
      return;
    }
    if (!Array.isArray(videos) || videos.length === 0) {
      res.status(400).json({ error: 'videos must be a non-empty array' });
      return;
    }
    if (!videos.every(isQueueVideoInput)) {
      res.status(400).json({ error: 'videos must contain objects' });
      return;
    }

    await fs.mkdir(folderPath, { recursive: true });
    const options = await loadDownloadOptions(folderPath);

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
        const entry = await findEntryByVideoId(folderPath, videoId);
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

    const jobs = requests.length > 0 ? downloadQueue.enqueue(requests) : [];
    res.status(202).json({ jobs, skipped });
  } catch (error) {
    sendError(res, 500, 'Failed to enqueue downloads', error);
  }
};

const listJobs: RouteHandler<NoParams, QueueListResponse> = (req, res) => {
  const folderPath = readFolderFilter(req.query.folderPath, res);
  if (folderPath === false) return;
  res.json({ jobs: downloadQueue.list(folderPath) });
};

const cancelAllJobs: RouteHandler<NoParams, CancelAllResponse> = (req, res) => {
  const folderPath = readFolderFilter(req.query.folderPath, res);
  if (folderPath === false) return;
  res.json({ cancelled: downloadQueue.cancelAll(folderPath) });
};

const cancelJob: RouteHandler<{ jobId: string }, CancelJobResponse> = (req, res) => {
  const job = downloadQueue.get(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }
  const cancelled = downloadQueue.cancel(job.id);
  res.json(stripUndefined<CancelJobResponse>({ cancelled, job: downloadQueue.get(job.id) }));
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
    const [job] = downloadQueue.enqueue([
      { folderPath, videoId, videoUrl, type: 'download', options },
    ]);
    if (!job) {
      throw new Error('Queue did not return a job');
    }
    sendEvent({ type: 'start', message: 'Starting download...' });

    let seenLogCount = 0;
    let finished = false;

    const finish = (snapshot: QueueJob) => {
      if (finished) return;
      finished = true;
      downloadQueue.off('job', onJob);
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

    downloadQueue.on('job', onJob);

    // Job may already be finished (deduped against a completed one is not
    // possible, but a very fast failure is) — replay current state.
    const current = downloadQueue.get(job.id);
    if (current) {
      onJob(current);
    }

    req.on('close', () => {
      finished = true;
      downloadQueue.off('job', onJob);
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

export default router;
