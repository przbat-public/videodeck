import type { ApiError, EnqueueJobsResponse, JobType, QueueJob, QueueVideoInput } from '@videodeck/shared/api';
import { EnqueueJobsResponseSchema } from '@videodeck/shared/schemas';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import i18n from '../i18n';
import { fetchQueue } from './fetchQueue';

export interface UseDownloadQueueOptions {
  /** Poll interval while jobs are active (ms) */
  pollIntervalMs?: number;
  /** When false the hook does not fetch until enabled again (default true) */
  enabled?: boolean;
  /** Called once for every job the first time it is seen as finished */
  onJobFinished?: (job: QueueJob) => void;
  /** Called when the queue goes from having active jobs to being idle */
  onQueueDrained?: () => void;
  /**
   * Called after this hook queued or cancelled a job, once its own refresh
   * has landed. The channel console polls the whole queue only while it
   * already sees something active, so it has to be told about a first job.
   */
  onQueueChanged?: () => void;
}

export const isActiveJob = (job: QueueJob): boolean => job.status === 'queued' || job.status === 'running';

const DEFAULT_POLL_MS = 1500;

/**
 * Client view of the server-side download queue for one folder.
 * Jobs run on the server; this hook only polls their state while anything
 * is queued/running, and exposes enqueue/cancel helpers.
 */
export function useDownloadQueue(folderPath: string, options: UseDownloadQueueOptions = {}) {
  const { pollIntervalMs = DEFAULT_POLL_MS, onJobFinished, onQueueDrained, onQueueChanged, enabled = true } = options;
  const [jobs, setJobs] = useState<QueueJob[]>([]);
  const [error, setError] = useState<string | null>(null);

  const seenFinishedRef = useRef<Set<string>>(new Set());
  const wasActiveRef = useRef(false);
  const callbacksRef = useRef({ onJobFinished, onQueueDrained });
  callbacksRef.current = { onJobFinished, onQueueDrained };
  const abortRef = useRef<AbortController | null>(null);

  // Stop the last poll on unmount (a new refresh aborts the previous one)
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const refresh = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const data = await fetchQueue(controller.signal, folderPath);
      setJobs(Array.isArray(data.jobs) ? data.jobs : []);
      setError(null);
    } catch (err) {
      if (controller.signal.aborted) {
        return; // superseded poll or unmount — nothing to report
      }
      setError(err instanceof Error ? err.message : i18n.t('errors.loadQueue'));
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
        let message = i18n.t('errors.enqueue');
        try {
          const body: ApiError = await response.json();
          message = body.error || body.message || message;
        } catch {
          // keep default message
        }
        throw new Error(message);
      }
      const result = EnqueueJobsResponseSchema.parse(await response.json());
      await refresh();
      onQueueChanged?.();
      return result;
    },
    [folderPath, onQueueChanged, refresh],
  );

  const cancel = useCallback(
    async (jobId: string) => {
      await fetch(`/api/folder/queue/${encodeURIComponent(jobId)}`, { method: 'DELETE' });
      await refresh();
      onQueueChanged?.();
    },
    [onQueueChanged, refresh],
  );

  const cancelAll = useCallback(async () => {
    await fetch(`/api/folder/queue?folderPath=${encodeURIComponent(folderPath)}`, {
      method: 'DELETE',
    });
    await refresh();
    onQueueChanged?.();
  }, [folderPath, onQueueChanged, refresh]);

  // Reset per-folder tracking when the folder changes (adjusted during
  // render instead of in an effect — React docs pattern for resetting state).
  const [jobsFolder, setJobsFolder] = useState(folderPath);
  if (jobsFolder !== folderPath) {
    setJobsFolder(folderPath);
    seenFinishedRef.current = new Set();
    wasActiveRef.current = false;
    setJobs([]);
  }

  // Load the current state (skipped while disabled — folders without a
  // list.json have no queue worth polling)
  useEffect(() => {
    if (enabled) {
      void refresh();
    }
  }, [refresh, enabled]);

  const hasActive = useMemo(() => jobs.some(isActiveJob), [jobs]);
  const activeCount = useMemo(() => jobs.filter(isActiveJob).length, [jobs]);

  // Poll only while something is queued or running, and not while the tab
  // is hidden (the browser throttles timers anyway — skip the work early).
  useEffect(() => {
    if (!hasActive || !enabled) {
      return;
    }
    const timer = setInterval(() => {
      if (document.visibilityState !== 'hidden') {
        void refresh();
      }
    }, pollIntervalMs);
    return () => clearInterval(timer);
  }, [hasActive, enabled, pollIntervalMs, refresh]);

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
