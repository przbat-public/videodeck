import type { EnqueueJobsResponse, JobType, QueueJob, QueueListJob, QueueVideoInput } from '@videodeck/shared/api';
import { EnqueueJobsResponseSchema } from '@videodeck/shared/schemas';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import i18n from '../i18n';
import { apiSend } from '../utils/apiClient';
import { fetchQueue, fetchQueueJobLog } from './fetchQueue';

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
  const onQueueChangedRef = useRef(onQueueChanged);
  onQueueChangedRef.current = onQueueChanged;
  const [jobs, setJobs] = useState<QueueJob[]>([]);
  const [error, setError] = useState<string | null>(null);

  const seenFinishedRef = useRef<Set<string>>(new Set());
  const wasActiveRef = useRef(false);
  const callbacksRef = useRef({ onJobFinished, onQueueDrained });
  callbacksRef.current = { onJobFinished, onQueueDrained };
  const abortRef = useRef<AbortController | null>(null);
  /**
   * Log tails fetched per job id. The queue list deliberately carries none
   * (polling it with every log was megabytes), and a failed row is the only
   * place that renders one.
   */
  const logsRef = useRef(new Map<string, string[]>());

  // Stop the last poll on unmount (a new refresh aborts the previous one)
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  /** Attach the logs already fetched for these jobs */
  const applyJobs = useCallback((incoming: readonly QueueListJob[]): void => {
    setJobs(
      incoming.map((job) => ({
        ...job,
        log: logsRef.current.get(job.id) ?? [],
        logLineCount: 0,
      })),
    );
  }, []);

  /** Fetch the log tail of every failed job that has none yet, once per job */
  const loadErrorLogs = useCallback(async (incoming: readonly QueueListJob[], signal: AbortSignal): Promise<void> => {
    const missing = incoming.filter((job) => job.status === 'error' && !logsRef.current.has(job.id));
    await Promise.all(
      missing.map(async (job) => {
        const log = await fetchQueueJobLog(job.id, signal);
        if (log === null || signal.aborted) {
          return;
        }
        logsRef.current.set(job.id, log);
        setJobs((previous) => previous.map((entry) => (entry.id === job.id ? { ...entry, log } : entry)));
      }),
    );
  }, []);

  const refresh = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const data = await fetchQueue(controller.signal, folderPath);
      applyJobs(Array.isArray(data.jobs) ? data.jobs : []);
      setError(null);
      await loadErrorLogs(data.jobs ?? [], controller.signal);
    } catch (err) {
      if (controller.signal.aborted) {
        return; // superseded poll or unmount — nothing to report
      }
      setError(err instanceof Error ? err.message : i18n.t('errors.loadQueue'));
    }
  }, [folderPath, applyJobs, loadErrorLogs]);

  const enqueue = useCallback(
    async (videos: QueueVideoInput[], type: JobType): Promise<EnqueueJobsResponse> => {
      if (videos.length === 0) {
        return { jobs: [], skipped: [] };
      }
      const result = await apiSend(
        'POST',
        '/api/folder/queue',
        EnqueueJobsResponseSchema,
        { folderPath, type, videos },
        { failureMessage: (failure) => failure.message ?? i18n.t('errors.enqueue') },
      );
      await refresh();
      onQueueChangedRef.current?.();
      return result;
    },
    [folderPath, refresh],
  );

  const cancel = useCallback(
    async (jobId: string) => {
      await fetch(`/api/folder/queue/${encodeURIComponent(jobId)}`, { method: 'DELETE' });
      // Paint the cancelled row before the refresh: a superseded GET used to
      // leave the row on "queued" until the next poll, and the console's
      // follow-up read is what typically supersedes it.
      setJobs((previous) =>
        previous.map((job) => (job.id === jobId && isActiveJob(job) ? { ...job, status: 'cancelled' } : job)),
      );
      await refresh();
      onQueueChangedRef.current?.();
    },
    [refresh],
  );

  const cancelAll = useCallback(async () => {
    await fetch(`/api/folder/queue?folderPath=${encodeURIComponent(folderPath)}`, {
      method: 'DELETE',
    });
    setJobs((previous) => previous.map((job) => (isActiveJob(job) ? { ...job, status: 'cancelled' } : job)));
    await refresh();
    onQueueChangedRef.current?.();
  }, [folderPath, refresh]);

  // Reset per-folder tracking when the folder changes (adjusted during
  // render instead of in an effect — React docs pattern for resetting state).
  const [jobsFolder, setJobsFolder] = useState(folderPath);
  if (jobsFolder !== folderPath) {
    setJobsFolder(folderPath);
    seenFinishedRef.current = new Set();
    wasActiveRef.current = false;
    logsRef.current = new Map();
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
