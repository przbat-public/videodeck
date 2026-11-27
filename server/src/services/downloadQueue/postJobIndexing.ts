import type { QueueJob } from '@videodeck/shared/api';
import { listVisibleFiles } from '../../utils/fsUtils';
import { logger } from '../../utils/logger';
import type { FolderIndex } from '../folderIndex';
import { findVideoFile, refreshIndex } from '../folderIndex';
import { indexVideosFromDisk } from '../videoScanner';

/**
 * Post-job work: check that the job produced what it promised, push the videos
 * it changed into Elasticsearch, and keep retrying that batch in the background
 * while the cluster is unreachable.
 *
 * The per-folder hook chain that decides when a hook runs stays on
 * `DownloadQueue`, because it is instance state. What sits here is the default
 * hook and its retry timers. Those timers are module-level on purpose: one
 * pending retry per folder, whatever the number of queue instances.
 */

/**
 * Mark a finished job whose media never appeared on disk.
 *
 * yt-dlp runs with `-i`, so a download that produced nothing at all (subtitle
 * only, a half-written file removed afterwards) still exits 0. The queue then reported a green job, the
 * console counted the video as downloaded, and the video was not there. The
 * disk is the only witness worth trusting, so the job carries the verdict.
 *
 * The verdict reads the index the post-job refresh returned, not the one on
 * disk before it: the enqueue route builds the folder index before the job
 * runs, so that one never lists the video the job downloaded, and every
 * successful download used to come out flagged. `files` is the folder as the
 * job left it, listed before the refresh writes anything of its own.
 *
 * Returns the log line to append, or null for a job that produced its file.
 */
export function detectIncompleteJob(job: QueueJob, index: FolderIndex, files: Set<string>): string | null {
  if (job.type === 'update') {
    // An update rewrites the sidecars of a video that is already there.
    return null;
  }
  if (files.size === 0) {
    // No visible files at all: a folder on a drive that went away reads the
    // same way as a folder that lost everything, and blaming the job for an
    // unplugged disk would be wrong twice.
    return null;
  }
  const baseName = index.entries[job.videoId]?.baseName ?? job.baseName;
  if (baseName === undefined) {
    // The refresh adds a video only once its media file is there
    return `incomplete: ${job.videoId} has no video file on disk after a successful exit`;
  }
  if (findVideoFile(baseName, files) !== undefined) {
    return null;
  }
  const sidecars = [...files].filter((file) => file.startsWith(`${baseName}.`));
  return sidecars.length > 0
    ? `incomplete: ${baseName} has no video file, only ${sidecars.length} sidecar(s)`
    : `incomplete: ${baseName} is not on disk after a successful exit`;
}

/**
 * Default post-job hook: refresh the folder's `.videos-index.json`, flag a job
 * that produced nothing, and push the videos whose files changed during the
 * job into Elasticsearch, so a download or metadata update is searchable
 * without a full reindex.
 *
 * When Elasticsearch is down the failure is NOT swallowed: the index mtimes
 * are already updated by refreshIndex, so the change would never be
 * re-detected — the batch is retried in the background with backoff instead
 * of losing the video from search until the next full reindex.
 */
export async function indexChangedVideos(job: QueueJob): Promise<void> {
  // Listed before the refresh, which can write into the folder: the verdict
  // needs the folder as the job left it
  const files = await listVisibleFiles(job.folderPath).then(
    (names) => new Set(names),
    (error: unknown) => {
      // A folder that cannot be listed must not turn a finished job into a
      // failed one: the next queue poll simply shows no verdict.
      logger.warn(`Job ${job.id}: could not verify the download: ${error instanceof Error ? error.message : error}`);
      return null;
    },
  );

  const since = new Date(job.startedAt ?? job.createdAt).getTime();
  // An update or a repair names the stem it worked on. A sidecar repair
  // leaves that stem's info.json untouched (--no-overwrites), so the mtime
  // window alone would never see the subtitle it fetched: the stem is re-read
  // regardless.
  const ownStem = job.type !== 'download' && job.baseName !== undefined ? [job.baseName] : [];
  const { index, changed } = await refreshIndex(job.folderPath, since, ownStem);
  if (files !== null) {
    recordVerdict(job, detectIncompleteJob(job, index, files));
  }

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

/** Record the verdict of `detectIncompleteJob` on the job and in its log */
function recordVerdict(job: QueueJob, reason: string | null): void {
  if (reason === null) {
    return;
  }
  job.incomplete = true;
  job.log.push(reason);
  job.logLineCount += 1;
  logger.warn(`Job ${job.id}: ${reason}`);
}

/** A folder's videos whose incremental indexing failed, waiting for a retry */
interface PendingIndexRetry {
  timer: NodeJS.Timeout;
  baseNames: Set<string>;
  attempt: number;
}

/** One pending retry per folder, holding every batch that failed there */
const indexRetries = new Map<string, PendingIndexRetry>();
/** Backoff per folder: 30 s, 2 min, 8 min, then give up */
const INDEX_RETRY_DELAYS_MS = [30_000, 120_000, 480_000];

/** Tests: drop pending index retries */
export function clearIndexRetries(): void {
  for (const pending of indexRetries.values()) {
    clearTimeout(pending.timer);
  }
  indexRetries.clear();
}

/**
 * Retry indexing a batch of videos, merged into the folder's pending retry.
 * A newer failure used to replace the pending batch, so the videos of the
 * earlier one never reached search and nothing said so. Now the batches are
 * a union, and the earliest attempt wins: a fresh failure restarts the
 * backoff, and an old batch's give-up never takes a newer one with it.
 */
function scheduleIndexRetry(folderPath: string, baseNames: string[], attempt = 0): void {
  const pending = indexRetries.get(folderPath);
  const stems = new Set([...(pending?.baseNames ?? []), ...baseNames]);
  const nextAttempt = pending === undefined ? attempt : Math.min(pending.attempt, attempt);
  if (pending) {
    clearTimeout(pending.timer);
  }
  if (nextAttempt >= INDEX_RETRY_DELAYS_MS.length) {
    indexRetries.delete(folderPath);
    logger.error(
      `Giving up indexing ${stems.size} videos in ${folderPath} after ${nextAttempt} retries: ${[...stems].join(', ')}`,
    );
    return;
  }
  const delay = INDEX_RETRY_DELAYS_MS[nextAttempt] ?? 480_000;
  const timer = setTimeout(() => {
    indexRetries.delete(folderPath);
    const batch = [...stems];
    void indexVideosFromDisk(folderPath, batch)
      .then((indexed) => {
        if (indexed < batch.length) {
          logger.warn(`Retry indexed ${indexed}/${batch.length} videos in ${folderPath}`);
          scheduleIndexRetry(folderPath, batch, nextAttempt + 1);
          return;
        }
        logger.info(`Retry indexed ${indexed}/${batch.length} videos in ${folderPath}`);
      })
      .catch((error: unknown) => {
        // The scanner swallows its own failures today, so this path only fires
        // if that changes. A rejection is a retry that did not land like a
        // short count, and it must never escape as an unhandled rejection that
        // takes the process down: log it and take the same bounded backoff.
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`Retry indexing ${batch.length} videos in ${folderPath} failed: ${message}`);
        scheduleIndexRetry(folderPath, batch, nextAttempt + 1);
      });
  }, delay);
  timer.unref();
  indexRetries.set(folderPath, { timer, baseNames: stems, attempt: nextAttempt });
}
