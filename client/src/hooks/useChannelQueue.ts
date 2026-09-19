import type { QueueJob } from '@videodeck/shared/api';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import i18n from '../i18n';
import { fetchQueue } from './fetchQueue';
import { isActiveJob } from './useDownloadQueue';

const DEFAULT_POLL_MS = 1500;

interface UseChannelQueueResult {
  /** Every job the server holds, across folders */
  jobs: QueueJob[];
  /** Jobs grouped by folder path, ready for the console's rows */
  jobsByFolder: Record<string, QueueJob[]>;
  error: string | null;
  refresh: () => Promise<void>;
}

/**
 * The whole queue, for the channel console's one row per channel. One request
 * covers every channel, replacing the per-folder poll the stacked sections
 * used to run; polling continues only while something is queued or running.
 */
export function useChannelQueue(enabled = true, pollIntervalMs = DEFAULT_POLL_MS): UseChannelQueueResult {
  const [jobs, setJobs] = useState<QueueJob[]>([]);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const data = await fetchQueue(controller.signal);
      setJobs(data.jobs);
      setError(null);
    } catch (err) {
      if (controller.signal.aborted) {
        return; // superseded poll or unmount
      }
      setError(err instanceof Error ? err.message : i18n.t('errors.loadQueue'));
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    void refresh();
    return () => {
      abortRef.current?.abort();
    };
  }, [enabled, refresh]);

  const hasActive = useMemo(() => jobs.some(isActiveJob), [jobs]);

  useEffect(() => {
    if (!enabled || !hasActive) {
      return;
    }
    const timer = setInterval(() => {
      if (document.visibilityState !== 'hidden') {
        void refresh();
      }
    }, pollIntervalMs);
    return () => clearInterval(timer);
  }, [enabled, hasActive, pollIntervalMs, refresh]);

  const jobsByFolder = useMemo(() => {
    const grouped: Record<string, QueueJob[]> = {};
    for (const job of jobs) {
      const existing = grouped[job.folderPath];
      if (existing === undefined) {
        grouped[job.folderPath] = [job];
      } else {
        existing.push(job);
      }
    }
    return grouped;
  }, [jobs]);

  return { jobs, jobsByFolder, error, refresh };
}
