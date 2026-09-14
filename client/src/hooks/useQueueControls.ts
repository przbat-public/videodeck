import { useCallback, useEffect, useState } from 'react';
import {
  QueueListResponseSchema,
  ClearFinishedResponseSchema,
  QueuePauseResponseSchema,
} from '@shared/schemas';

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

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch('/api/folder/queue', signal ? { signal } : {});
    if (!response.ok) {
      throw new Error(`Failed to fetch queue (HTTP ${response.status})`);
    }
    const data = QueueListResponseSchema.parse(await response.json());
    setIsPaused(data.paused);
    setFinishedCount(
      data.jobs.filter(
        (job) => job.status === 'done' || job.status === 'error' || job.status === 'cancelled'
      ).length
    );
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    refresh(controller.signal).catch(() => undefined);
    return () => controller.abort();
  }, [refresh]);

  const setPaused = useCallback(async (next: boolean): Promise<void> => {
    setLoading(true);
    try {
      const response = await fetch(
        `/api/folder/queue/${next ? 'pause' : 'resume'}?paused=${next ? '1' : '0'}`,
        { method: 'POST' }
      );
      if (!response.ok) {
        throw new Error(`Failed to ${next ? 'pause' : 'resume'} queue (HTTP ${response.status})`);
      }
      setIsPaused(QueuePauseResponseSchema.parse(await response.json()).paused);
    } finally {
      setLoading(false);
    }
  }, []);

  const clearFinished = useCallback(async (): Promise<void> => {
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
