import express from 'express';
import { downloadQueue } from '../services/downloadQueue';
import { getStatus, saveFolderConfig } from './folder/config';
import { createDownloadVideo } from './folder/downloadVideo';
import { getFolderList, listExists, rebuildFolderIndex } from './folder/list';
import { downloadPlaylist } from './folder/playlist';
import type { DownloadQueueLike } from './folder/queue';
import { createQueueHandlers } from './folder/queue';
import { getFolderSummaries } from './folder/summaries';

/**
 * Public surface of the folder routes.
 *
 * The implementation lives in ./folder, split along seven seams: guards (the
 * folder allowlist check every handler authorizes through), config (GET
 * /status and the config write, plus the status cache they share), list (the
 * list.json reads and the index rebuild), summaries (the per-folder counts and
 * their cache), playlist (the yt-dlp channel fetch), queue (the job endpoints)
 * and downloadVideo (the single-video SSE stream and its event plumbing).
 *
 * What stayed here is the wiring, because the order of the registrations below
 * is behaviour: Express matches in registration order, so the static
 * `/folder/queue/summaries` and `/folder/queue/finished` have to stay ahead of
 * `/folder/queue/:jobId`. The factory also stays here: it closes over the
 * injected queue and hands it to the handlers that need one.
 *
 * This module re-exports every name it exported before the split, so importers
 * and tests keep working without changes. New internals belong in the module
 * they serve, not here.
 */

export { invalidateStatusCache } from './folder/config';
export type { DownloadQueueLike } from './folder/queue';
export { invalidateSummaryCache } from './folder/summaries';

/**
 * The folder routes are a factory so the application can inject the download
 * queue (createApp options) instead of the handlers reaching for a module
 * singleton. Each call closes over its own queue instance.
 */
export function createFolderRouter(queue: DownloadQueueLike = downloadQueue): express.Router {
  const queueHandlers = createQueueHandlers(queue);
  const downloadVideo = createDownloadVideo(queue);

  const router = express.Router();

  router.get('/status', getStatus);
  router.put('/folder/config', saveFolderConfig);
  router.get('/folder/list-exists', listExists);
  router.get('/folder/list', getFolderList);
  router.get('/folder/summaries', getFolderSummaries);
  router.post('/folder/rebuild-index', rebuildFolderIndex);
  router.post('/folder/download-playlist', downloadPlaylist);
  router.get('/folder/video-downloaded', queueHandlers.isVideoDownloaded);
  router.post('/folder/queue', queueHandlers.enqueueJobs);
  router.get('/folder/queue', queueHandlers.listJobs);
  router.delete('/folder/queue', queueHandlers.cancelAllJobs);
  // registered before /:jobId so "summaries" is not read as a job id
  router.get('/folder/queue/summaries', queueHandlers.getQueueSummary);
  router.get('/folder/queue/:jobId', queueHandlers.getJob);
  router.post('/folder/queue/pause', queueHandlers.setQueuePaused);
  router.post('/folder/queue/resume', queueHandlers.setQueuePaused);
  // registered before /:jobId so "finished" is not read as a job id
  router.delete('/folder/queue/finished', queueHandlers.clearFinishedJobs);
  router.delete('/folder/queue/:jobId', queueHandlers.cancelJob);
  router.post('/folder/download-video', downloadVideo);

  return router;
}
