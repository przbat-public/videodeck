import fs from 'node:fs/promises';
import type { ApiError, DownloadVideoEvent, QueueJob } from '@videodeck/shared/api';
import { downloadVideoEventSchema } from '@videodeck/shared/schemas';
import { extractYoutubeVideoId, toWatchUrl } from '@videodeck/shared/youtube';
import type { Response } from 'express';
import { getVideosFolderPaths } from '../../config';
import { sseStreamsOpen } from '../../metrics';
import { loadDownloadOptions } from '../../services/folderConfig';
import { logger } from '../../utils/logger';
import { registerSseStream } from '../../utils/sseRegistry';
import { normalizeFolderPath } from '../../utils/videoPathUtils';
import type { NoParams, RouteHandler } from '../http';
import { readBody, readString, sendError } from '../http';
import { firstZodError } from '../validation';
import { requireAllowedFolder } from './guards';
import type { DownloadQueueLike } from './queue';

/**
 * POST /api/folder/download-video: one video, queued, streamed back as
 * Server-Sent Events (the Chrome extension's path).
 *
 * The stream is the only thing here that holds state, and it releases all of
 * it on close: the heartbeat interval, the queue listeners, the shutdown
 * registry entry and the open-stream gauge. Closing the connection stops the
 * stream, never the download.
 */

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
export function createDownloadVideo(queue: DownloadQueueLike): RouteHandler<NoParams, never> {
  return async (req, res) => {
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
