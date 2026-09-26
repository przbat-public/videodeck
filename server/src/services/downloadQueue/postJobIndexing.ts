import type { QueueJob } from '@videodeck/shared/api';
import { logger } from '../../utils/logger';
import { refreshIndex } from '../folderIndex';
import { indexVideosFromDisk } from '../videoScanner';

/**
 * Post-job indexing: push the videos a finished job changed into
 * Elasticsearch, and keep retrying the batch in the background while the
 * cluster is unreachable.
 *
 * The per-folder hook chain that decides when a hook runs stays on
 * `DownloadQueue`, because it is instance state. What sits here is the default
 * hook and its retry timers. Those timers are module-level on purpose: one
 * pending retry per folder, whatever the number of queue instances.
 */

/**
 * Default post-job hook: refresh the folder's `.videos-index.json` and push
 * the videos whose files changed during the job into Elasticsearch, so a
 * download or metadata update is searchable without a full reindex.
 *
 * When Elasticsearch is down the failure is NOT swallowed: the index mtimes
 * are already updated by refreshIndex, so the change would never be
 * re-detected — the batch is retried in the background with backoff instead
 * of losing the video from search until the next full reindex.
 */
export async function indexChangedVideos(job: QueueJob): Promise<void> {
  const since = new Date(job.startedAt ?? job.createdAt).getTime();
  const { index, changed } = await refreshIndex(job.folderPath, since);
  const baseNames = changed
    .map((videoId) => index.entries[videoId]?.baseName)
    .filter((baseName): baseName is string => typeof baseName === 'string');
  if (baseNames.length === 0) {
    return;
  }
  // indexVideosFromDisk logs per-video failures and never rejects, so a short
  // count is the only signal that part of the batch did not land.
  const indexed = await indexVideosFromDisk(job.folderPath, baseNames);
  if (indexed < baseNames.length) {
    logger.error(`Job ${job.id}: indexed ${indexed}/${baseNames.length} changed videos, will retry`);
    scheduleIndexRetry(job.folderPath, baseNames);
    return;
  }
  logger.info(`Job ${job.id}: indexed ${indexed}/${baseNames.length} changed videos in Elasticsearch`);
}

/** Folders whose incremental indexing failed and is waiting for a retry */
const indexRetryTimers = new Map<string, NodeJS.Timeout>();
/** Backoff per folder: 30 s, 2 min, 8 min, then give up */
const INDEX_RETRY_DELAYS_MS = [30_000, 120_000, 480_000];

/** Tests: drop pending index retries */
export function clearIndexRetries(): void {
  for (const timer of indexRetryTimers.values()) {
    clearTimeout(timer);
  }
  indexRetryTimers.clear();
}

function scheduleIndexRetry(folderPath: string, baseNames: string[], attempt = 0): void {
  const existing = indexRetryTimers.get(folderPath);
  if (existing) {
    clearTimeout(existing); // a newer failure supersedes the pending retry
  }
  if (attempt >= INDEX_RETRY_DELAYS_MS.length) {
    logger.error(`Giving up indexing ${baseNames.length} videos in ${folderPath} after ${attempt} retries`);
    return;
  }
  const delay = INDEX_RETRY_DELAYS_MS[attempt] ?? 480_000;
  const timer = setTimeout(() => {
    indexRetryTimers.delete(folderPath);
    void indexVideosFromDisk(folderPath, baseNames)
      .then((indexed) => {
        if (indexed < baseNames.length) {
          logger.warn(`Retry indexed ${indexed}/${baseNames.length} videos in ${folderPath}`);
          scheduleIndexRetry(folderPath, baseNames, attempt + 1);
          return;
        }
        logger.info(`Retry indexed ${indexed}/${baseNames.length} videos in ${folderPath}`);
      })
      .catch((error: unknown) => {
        // The scanner swallows its own failures today, so this path only fires
        // if that changes. A rejection is a retry that did not land like a
        // short count, and it must never escape as an unhandled rejection that
        // takes the process down: log it and take the same bounded backoff.
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`Retry indexing ${baseNames.length} videos in ${folderPath} failed: ${message}`);
        scheduleIndexRetry(folderPath, baseNames, attempt + 1);
      });
  }, delay);
  timer.unref();
  indexRetryTimers.set(folderPath, timer);
}
