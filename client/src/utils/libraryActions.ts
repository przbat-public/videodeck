import type { ArchiveReconcileResponse, EnqueueJobsResponse } from '@videodeck/shared/api';
import { ArchiveReconcileResponseSchema, EnqueueJobsResponseSchema } from '@videodeck/shared/schemas';
import toast from 'react-hot-toast';
import i18n from '../i18n';
import { apiSend } from './apiClient';
import { skipReasonText } from './videoState';

/**
 * The two library repairs the console asks the server for, kept beside the
 * pure selection rules: the row menu and the video panel start the same
 * request, and one place wording a toast keeps them from drifting apart.
 */

/** Which sidecars a repair job refreshes */
export type RepairMethod = 'sidecars' | 'comments';

/** Queue sidecar-only jobs for the videos named. Nothing is downloaded here */
export async function repairVideos(
  folderPath: string,
  videoIds: readonly string[],
  method: RepairMethod,
): Promise<EnqueueJobsResponse> {
  return apiSend(
    'POST',
    '/api/folder/repair',
    EnqueueJobsResponseSchema,
    { folderPath, method, videos: videoIds.map((videoId) => ({ videoId })) },
    { failureMessage: (failure) => failure.message ?? i18n.t('toast.enqueueFailed') },
  );
}

/** How many videos were queued, and why the server refused the rest */
export function toastRepairResult(result: EnqueueJobsResponse, method: RepairMethod): void {
  if (result.jobs.length > 0) {
    toast.success(
      i18n.t(method === 'comments' ? 'toast.commentsQueued' : 'toast.repairQueued', { count: result.jobs.length }),
    );
  }
  const [firstSkipped] = result.skipped;
  if (firstSkipped) {
    toast.error(
      i18n.t('toast.skipped', {
        count: result.skipped.length,
        reason: skipReasonText(firstSkipped.reason, i18n.t),
      }),
    );
  }
}

/**
 * Bring `archive.txt` in line with the disk. `rebuild` is the whole-truth
 * method: the app adds what the index holds and drops what it does not, which
 * is the fix for both directions of drift.
 */
export async function reconcileArchive(folderPath: string): Promise<ArchiveReconcileResponse> {
  return apiSend(
    'POST',
    '/api/folder/archive/reconcile',
    ArchiveReconcileResponseSchema,
    { folderPath, method: 'rebuild' },
    { failureMessage: (failure) => failure.message ?? i18n.t('toast.enqueueFailed') },
  );
}

/** What the reconcile changed, or that the archive already agreed */
export function toastReconcileResult(result: ArchiveReconcileResponse): void {
  if (result.added.length + result.removed.length === 0) {
    toast.success(i18n.t('toast.archiveAligned', { unchanged: result.unchanged }));
    return;
  }
  toast.success(i18n.t('toast.archiveReconciled', { added: result.added.length, removed: result.removed.length }));
}
