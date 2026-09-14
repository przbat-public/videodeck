import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ApiError,
  EnqueueJobsResponse,
  JobType,
  QueueJob,
  QueueListResponse,
  QueueVideoInput,
} from '@shared/api';

export interface UseDownloadQueueOptions {
  /** Poll interval while jobs are active (ms) */
  pollIntervalMs?: number;
  /** Called once for every job the first time it is seen as finished */
  onJobFinished?: (job: QueueJob) => void;
  /** Called when the queue goes from having active jobs to being idle */
  onQueueDrained?: () => void;
}

export const isActiveJob = (job: QueueJob): boolean =>
  job.status === 'queued' || job.status === 'running';

const DEFAULT_POLL_MS = 1500;

/**
 * Client view of the server-side download queue for one folder.
 * Jobs run on the server; this hook only polls their state while anything
 * is queued/running, and exposes enqueue/cancel helpers.
 */
export function useDownloadQueue(folderPath: string, options: UseDownloadQueueOptions = {}) {
  const { pollIntervalMs = DEFAULT_POLL_MS, onJobFinished, onQueueDrained } = options;
  const [jobs, setJobs] = useState<QueueJob[]>([]);
  const [error, setError] = useState<string | null>(null);

  const seenFinishedRef = useRef<Set<string>>(new Set());
  const wasActiveRef = useRef(false);
  const callbacksRef = useRef({ onJobFinished, onQueueDrained });
  callbacksRef.current = { onJobFinished, onQueueDrained };

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(
        `/api/folder/queue?folderPath=${encodeURIComponent(folderPath)}`
      );
      if (!response.ok) {
        throw new Error('Failed to load download queue');
      }
      const data: QueueListResponse = await response.json();
      setJobs(Array.isArray(data.jobs) ? data.jobs : []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load download queue');
    }
  }, [folderPath]);

  const enqueue = useCallback(
    async (videos: QueueVideoInput[], type: JobType): Promise<EnqueueJobsResponse> => {
      if (videos.length === 0) {
        return { jobs: [], skipped: [] };
      }
      const response = await fetch('/api/folder/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderPath, type, videos }),
      });
      if (!response.ok) {
        let message = 'Failed to enqueue downloads';
        try {
          const body: ApiError = await response.json();
          message = body.error || body.message || message;
        } catch {
          // keep default message
        }
        throw new Error(message);
      }
      const result: EnqueueJobsResponse = await response.json();
      await refresh();
      return result;
    },
    [folderPath, refresh]
  );

  const cancel = useCallback(
    async (jobId: string) => {
      await fetch(`/api/folder/queue/${encodeURIComponent(jobId)}`, { method: 'DELETE' });
      await refresh();
    },
    [refresh]
  );

  const cancelAll = useCallback(async () => {
    await fetch(`/api/folder/queue?folderPath=${encodeURIComponent(folderPath)}`, {
      method: 'DELETE',
    });
    await refresh();
  }, [folderPath, refresh]);

  // Reset per-folder tracking when the folder changes (adjusted during
  // render instead of in an effect — React docs pattern for resetting state).
  const [jobsFolder, setJobsFolder] = useState(folderPath);
  if (jobsFolder !== folderPath) {
    setJobsFolder(folderPath);
    seenFinishedRef.current = new Set();
    wasActiveRef.current = false;
    setJobs([]);
  }

  // Load the current state
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const hasActive = useMemo(() => jobs.some(isActiveJob), [jobs]);
  const activeCount = useMemo(() => jobs.filter(isActiveJob).length, [jobs]);

  // Poll only while something is queued or running
  useEffect(() => {
    if (!hasActive) {
      return;
    }
    const timer = setInterval(() => {
      void refresh();
    }, pollIntervalMs);
    return () => clearInterval(timer);
  }, [hasActive, pollIntervalMs, refresh]);

  // Fire onJobFinished / onQueueDrained callbacks based on transitions
  useEffect(() => {
    for (const job of jobs) {
      if (!isActiveJob(job) && !seenFinishedRef.current.has(job.id)) {
        seenFinishedRef.current.add(job.id);
        callbacksRef.current.onJobFinished?.(job);
      }
    }
    if (wasActiveRef.current && !hasActive) {
      callbacksRef.current.onQueueDrained?.();
    }
    wasActiveRef.current = hasActive;
  }, [jobs, hasActive]);

  /** Most relevant job per video: an active one wins, otherwise the newest */
  const jobsByVideoId = useMemo(() => {
    const map: Record<string, QueueJob> = {};
    for (const job of jobs) {
      const current = map[job.videoId];
      if (!current) {
        map[job.videoId] = job;
        continue;
      }
      const currentActive = isActiveJob(current);
      const jobActive = isActiveJob(job);
      if (jobActive && !currentActive) {
        map[job.videoId] = job;
      } else if (jobActive === currentActive && job.createdAt > current.createdAt) {
        map[job.videoId] = job;
      }
    }
    return map;
  }, [jobs]);

  return {
    jobs,
    jobsByVideoId,
    hasActive,
    activeCount,
    error,
    refresh,
    enqueue,
    cancel,
    cancelAll,
  };
}
