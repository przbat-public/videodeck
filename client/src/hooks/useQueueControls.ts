import { ClearFinishedResponseSchema, QueuePauseResponseSchema } from '@videodeck/shared/schemas';
import { useCallback, useState } from 'react';
import i18n from '../i18n';
import { apiSend } from '../utils/apiClient';
import { refreshQueueSummary, useQueueSummary } from '../utils/queueSummaryStore';

interface UseQueueControlsResult {
  /** True while a control request is in flight */
  loading: boolean;
  /** Whether the server-side queue is paused */
  paused: boolean;
  /** How many finished (done/error/cancelled) jobs are kept in memory */
  finishedCount: number;
  /** Last failure of a read or a control request; cleared by the next success */
  error: string | null;
  setPaused: (paused: boolean) => Promise<void>;
  clearFinished: () => Promise<void>;
}

/** Message for a failed request, whether it threw an Error or something else */
function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : i18n.t('errors.occurred');
}

/**
 * Global queue controls for the status page: the queue itself is a single
 * server-side object shared by every folder, so the controls read the one
 * shared queue summary and refresh it after every action they take.
 */
export function useQueueControls(): UseQueueControlsResult {
  const { summary, error: readError } = useQueueSummary();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const counts = summary?.counts;
  const finishedCount = counts === undefined ? 0 : counts.done + counts.error + counts.cancelled;

  const setPaused = useCallback(async (next: boolean): Promise<void> => {
    setLoading(true);
    try {
      const result = await apiSend(
        'POST',
        `/api/folder/queue/${next ? 'pause' : 'resume'}?paused=${next ? '1' : '0'}`,
        QueuePauseResponseSchema,
        undefined,
        {
          message: (status) =>
            i18n.t(next ? 'errors.pauseQueue' : 'errors.resumeQueue', {
              status,
            }),
        },
      );
      setPaused(result.paused);
      setError(null);
    } catch (err) {
      setError(failureMessage(err));
    } finally {
      setLoading(false);
      await refreshQueueSummary();
    }
  }, []);

  const clearFinished = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      await apiSend('DELETE', '/api/folder/queue/finished', ClearFinishedResponseSchema, undefined, {
        message: (status) => i18n.t('errors.clearFinishedJobs', { status }),
      });
      await refreshQueueSummary();
    } catch (err) {
      setError(failureMessage(err));
    } finally {
      setLoading(false);
      await refreshQueueSummary();
    }
  }, []);

  return {
    loading,
    paused: summary?.paused ?? false,
    finishedCount,
    error: error ?? readError,
    setPaused,
    clearFinished,
  };
}
