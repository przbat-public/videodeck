import type { QueueListResponse } from '@videodeck/shared/api';
import { QueueListResponseSchema } from '@videodeck/shared/schemas';
import i18n from '../i18n';

/**
 * GET /api/folder/queue: one folder's jobs when a folder path is given,
 * the whole queue otherwise. Shared by the queue hooks so the URL shape,
 * the error message and the response parsing cannot drift apart.
 */
export async function fetchQueue(signal?: AbortSignal, folderPath?: string): Promise<QueueListResponse> {
  const url = folderPath ? `/api/folder/queue?folderPath=${encodeURIComponent(folderPath)}` : '/api/folder/queue';
  const response = await fetch(url, signal ? { signal } : {});
  if (!response.ok) {
    throw new Error(i18n.t('errors.loadQueue'));
  }
  return QueueListResponseSchema.parse(await response.json());
}
