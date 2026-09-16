import { ClearFinishedResponseSchema, QueuePauseResponseSchema } from '@videodeck/shared/schemas';
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchQueue } from './fetchQueue';

interface UseQueueControlsResult {
  /** True while a control request is in flight */
  loading: boolean;
  /** Whether the server-side queue is paused */
  paused: boolean;
  /** How many finished (done/error/cancelled) jobs are kept in memory */
  finishedCount: number;
  setPaused: (paused: boolean) => Promise<void>;
  clearFinished: () => Promise<void>;
}

/**
 * Global queue controls for the status page: the queue itself is a single
 * server-side object shared by every folder, so the controls are fetched
 * without a folder filter (GET /api/folder/queue with no query).
 */
export function useQueueControls(): UseQueueControlsResult {
  const [isPaused, setIsPaused] = useState(false);
  const [finishedCount, setFinishedCount] = useState(0);
  const [loading, setLoading] = useState(false);
  // Bumped on every mutation: a refresh that started earlier must not
  // overwrite the fresher state a pause/clear already applied (the mount
  // fetch can resolve after a quick pause click).
  const mutationVersionRef = useRef(0);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const versionAtStart = mutationVersionRef.current;
    const data = await fetchQueue(signal);
    if (mutationVersionRef.current !== versionAtStart) {
      return; // stale — a mutation has reported fresher state since
    }
    setIsPaused(data.paused);
    setFinishedCount(
      data.jobs.filter((job) => job.status === 'done' || job.status === 'error' || job.status === 'cancelled').length,
    );
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    refresh(controller.signal).catch(() => undefined);
    return () => controller.abort();
  }, [refresh]);

  const setPaused = useCallback(async (next: boolean): Promise<void> => {
    mutationVersionRef.current += 1;
    setLoading(true);
    try {
      const response = await fetch(`/api/folder/queue/${next ? 'pause' : 'resume'}?paused=${next ? '1' : '0'}`, {
        method: 'POST',
      });
      if (!response.ok) {
        throw new Error(`Failed to ${next ? 'pause' : 'resume'} queue (HTTP ${response.status})`);
      }
      setIsPaused(QueuePauseResponseSchema.parse(await response.json()).paused);
    } finally {
      setLoading(false);
    }
  }, []);

  const clearFinished = useCallback(async (): Promise<void> => {
    mutationVersionRef.current += 1;
    setLoading(true);
    try {
      const response = await fetch('/api/folder/queue/finished', { method: 'DELETE' });
      if (!response.ok) {
        throw new Error(`Failed to clear finished jobs (HTTP ${response.status})`);
      }
      ClearFinishedResponseSchema.parse(await response.json());
      await refresh().catch(() => undefined);
    } finally {
      setLoading(false);
    }
  }, [refresh]);

  return { loading, paused: isPaused, finishedCount, setPaused, clearFinished };
}
