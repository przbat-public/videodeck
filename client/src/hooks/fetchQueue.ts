import type { QueueListResponse } from '@videodeck/shared/api';
import { QueueListResponseSchema } from '@videodeck/shared/schemas';
import i18n from '../i18n';
import { apiGet } from '../utils/apiClient';

/**
 * GET /api/folder/queue: one folder's jobs when a folder path is given,
 * the whole queue otherwise. Shared by the queue hooks so the URL shape,
 * the error message and the response parsing cannot drift apart.
 */
export async function fetchQueue(signal?: AbortSignal, folderPath?: string): Promise<QueueListResponse> {
  const url = folderPath ? `/api/folder/queue?folderPath=${encodeURIComponent(folderPath)}` : '/api/folder/queue';
  // `no-store`: the queue is live state that this endpoint polls, and a
  // conditional request can come back as `304 Not Modified`, which `fetch`
  // reports as `ok: false` (the server used to answer exactly that, and the
  // queue controls showed a load error while the queue was healthy).
  return apiGet(url, QueueListResponseSchema, {
    cache: 'no-store',
    ...(signal ? { signal } : {}),
    message: i18n.t('errors.loadQueue'),
  });
}
