import path from 'node:path';
import type { QueueJob } from '@videodeck/shared/api';
import { DownloadOptionsSchema } from '@videodeck/shared/schemas';
import { toWatchUrl } from '@videodeck/shared/youtube';
import { logger } from '../../utils/logger';
import { stripUndefined } from '../../utils/objectUtils';
import { normalizeFolderPath } from '../../utils/videoPathUtils';
import type { EnqueueRequest } from './queue';

/**
 * Queue persistence: where the state file lives, what a snapshot of a job
 * holds, and which entries of a state file may go back into the queue.
 *
 * The write itself stays on `DownloadQueue`: the coalescing window, the
 * chained writes and `whenPersisted` are per-instance chain state that only
 * the class touches. This module owns the path, the snapshot shape and the
 * parsing rules, and keeps no mutable state of its own.
 */

/**
 * Coalescing window of the state file: transitions inside it share one
 * snapshot, which holds the whole queue.
 */
export const PERSIST_COALESCE_MS = 200;

/**
 * What a restart needs from a job: exactly the fields `restoreQueueState`
 * reads back. Status, progress, timestamps and the log tail describe the run,
 * not the work to re-enqueue, and the snapshot is rewritten on every
 * transition.
 */
export function toPersistedJob(job: QueueJob): EnqueueRequest {
  return stripUndefined<EnqueueRequest>({
    folderPath: job.folderPath,
    videoId: job.videoId,
    videoUrl: job.videoUrl,
    title: job.title,
    type: job.type,
    baseName: job.baseName,
    options: job.options,
  });
}

/** Where the singleton persists its active jobs (cwd = server/ by default) */
export const QUEUE_STATE_FILE = process.env.QUEUE_STATE_FILE ?? '.queue-state.json';

/**
 * Whether a persisted folder path is safe to spawn yt-dlp in: absolute,
 * already normalised (no trailing slash, no `~`) and free of `..` segments,
 * so a hand-edited state file cannot point the queue at another directory.
 *
 * The enqueue route additionally checks the path against the configured
 * folder list. Restore deliberately does not: the drive a folder lives on may
 * not be mounted yet when the server boots, and dropping the job then would
 * lose it silently.
 */
function isRestorableFolder(folderPath: string): boolean {
  return (
    path.isAbsolute(folderPath) &&
    normalizeFolderPath(folderPath) === folderPath &&
    !folderPath.split(path.sep).includes('..')
  );
}

/**
 * Convert one persisted job back into an enqueue request. Entries that do not
 * look like a job we wrote (corrupt hand-edited file) are skipped, and
 * unparseable options fall back to the folder defaults instead of reaching
 * buildYtDlpArgs as an unchecked cast.
 *
 * The URL is rebuilt from the id instead of read from the file: a hand-edited
 * state file could otherwise point yt-dlp at `file:///etc/passwd` or an
 * internal host, and the enqueue route is not in the way on this path.
 */
export function toEnqueueRequest(job: unknown): EnqueueRequest | null {
  if (!job || typeof job !== 'object') {
    return null;
  }
  const record = job as Record<string, unknown>;
  const { folderPath, videoId } = record;
  if (typeof folderPath !== 'string' || !isRestorableFolder(folderPath)) {
    return null;
  }
  if (typeof videoId !== 'string' || videoId.length === 0) {
    return null;
  }
  const options = record.options === undefined ? null : DownloadOptionsSchema.safeParse(record.options);
  if (options && !options.success) {
    logger.warn(`Queue state: dropping unreadable options of job ${videoId}`);
  }
  return {
    folderPath,
    videoId,
    videoUrl: toWatchUrl(videoId),
    ...(typeof record.title === 'string' ? { title: record.title } : {}),
    type: record.type === 'update' ? 'update' : 'download',
    ...(typeof record.baseName === 'string' ? { baseName: record.baseName } : {}),
    ...(options?.success ? { options: options.data } : {}),
  };
}
