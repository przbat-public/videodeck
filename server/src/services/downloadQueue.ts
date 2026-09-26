/**
 * Public surface of the download queue.
 *
 * The implementation lives in ./downloadQueue, split along four seams:
 * persistence (the state file, the snapshot shape and the rules for reading it
 * back), the watchdog (the group kill of a hung yt-dlp process), post-job
 * indexing (the default after-job hook and its retry timers) and the queue
 * core (job lifecycle, the spawn call, the log buffer, the event emitter, the
 * class and the singleton).
 *
 * This module re-exports every name it exported before the split, so importers
 * and tests keep working without changes. New internals belong in the module
 * they serve, not here.
 */

export { QUEUE_STATE_FILE } from './downloadQueue/persistence';

export { clearIndexRetries, indexChangedVideos } from './downloadQueue/postJobIndexing';

export type { DownloadQueueOptions, EnqueueRequest, SpawnedProcess, SpawnFn } from './downloadQueue/queue';
export {
  DownloadQueue,
  downloadQueue,
  readConcurrency,
  restoreQueueState,
  toListJob,
  YTDLP_PATH,
} from './downloadQueue/queue';

export { killProcessGroup } from './downloadQueue/watchdog';
