import type { QueueJobResponse, QueueListResponse, QueueSummaryResponse } from '@videodeck/shared/api';
import { QueueJobResponseSchema, QueueListResponseSchema, QueueSummaryResponseSchema } from '@videodeck/shared/schemas';
import i18n from '../i18n';

/**
 * Queue reads. GET /api/folder/queue carries no log lines and is capped: the
 * console polls GET /api/folder/queue/summaries, and a log tail is read one job
 * at a time from GET /api/folder/queue/:jobId. All three live here so the URL
 * shapes, the error message and the response parsing cannot drift apart.
 */
async function request(url: string, signal?: AbortSignal): Promise<Response> {
  // `no-store`: the queue is live state that these endpoints poll, and a
  // conditional request can come back as `304 Not Modified`, which `fetch`
  // reports as `ok: false` (the server used to answer exactly that, and the
  // queue controls showed a load error while the queue was healthy).
  const response = await fetch(url, { cache: 'no-store', ...(signal ? { signal } : {}) });
  if (!response.ok) {
    throw new Error(i18n.t('errors.loadQueue'));
  }
  return response;
}

/** One folder's jobs when a folder path is given, the capped whole queue otherwise */
export async function fetchQueue(signal?: AbortSignal, folderPath?: string): Promise<QueueListResponse> {
  const url = folderPath ? `/api/folder/queue?folderPath=${encodeURIComponent(folderPath)}` : '/api/folder/queue';
  return QueueListResponseSchema.parse(await (await request(url, signal)).json());
}

/** The queue's counters, per status and per folder, with the running jobs */
export async function fetchQueueSummary(signal?: AbortSignal): Promise<QueueSummaryResponse> {
  return QueueSummaryResponseSchema.parse(await (await request('/api/folder/queue/summaries', signal)).json());
}

/** One job's log tail, or null when the job is gone or unreadable */
export async function fetchQueueJobLog(jobId: string, signal?: AbortSignal): Promise<string[] | null> {
  try {
    const response = await request(`/api/folder/queue/${encodeURIComponent(jobId)}`, signal);
    const body: QueueJobResponse = QueueJobResponseSchema.parse(await response.json());
    return body.job.log;
  } catch {
    // The row still shows the error message; only the log tail is missing
    return null;
  }
}
