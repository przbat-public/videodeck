import { ClearFinishedResponseSchema, QueuePauseResponseSchema } from '@videodeck/shared/schemas';
import { useCallback, useEffect, useRef, useState } from 'react';
import i18n from '../i18n';
import { apiSend } from '../utils/apiClient';
import { fetchQueue } from './fetchQueue';

/** How often the controls re-read the queue while the status page is open */
const QUEUE_POLL_MS = 4000;

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
 * server-side object shared by every folder, so the controls are fetched
 * without a folder filter (GET /api/folder/queue with no query).
 */
export function useQueueControls(): UseQueueControlsResult {
  const [isPaused, setIsPaused] = useState(false);
  const [finishedCount, setFinishedCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped on every mutation: a refresh that started earlier must not
  // overwrite the fresher state a pause/clear already applied (the mount
  // fetch can resolve after a quick pause click).
  const mutationVersionRef = useRef(0);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const versionAtStart = mutationVersionRef.current;
    try {
      const data = await fetchQueue(signal);
      if (mutationVersionRef.current !== versionAtStart) {
        return; // stale — a mutation has reported fresher state since
      }
      setIsPaused(data.paused);
      setFinishedCount(
        data.jobs.filter((job) => job.status === 'done' || job.status === 'error' || job.status === 'cancelled').length,
      );
      setError(null);
    } catch (err) {
      if (signal?.aborted) {
        return; // unmounted: the failure belongs to nobody
      }
      setError(failureMessage(err));
    }
  }, []);

  // The queue is server-side and shared with the list pages, so a finished job
  // appears here only if the controls keep asking. Without the poll the
  // "clear finished" button stayed disabled until the page was reloaded.
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    const timer = setInterval(() => {
      if (document.visibilityState !== 'hidden') {
        void refresh();
      }
    }, QUEUE_POLL_MS);
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      controller.abort();
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh]);

  const setPaused = useCallback(async (next: boolean): Promise<void> => {
    mutationVersionRef.current += 1;
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
      setIsPaused(result.paused);
      setError(null);
    } catch (err) {
      setError(failureMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const clearFinished = useCallback(async (): Promise<void> => {
    mutationVersionRef.current += 1;
    setLoading(true);
    try {
      await apiSend('DELETE', '/api/folder/queue/finished', ClearFinishedResponseSchema, undefined, {
        message: (status) => i18n.t('errors.clearFinishedJobs', { status }),
      });
      await refresh();
    } catch (err) {
      setError(failureMessage(err));
    } finally {
      setLoading(false);
    }
  }, [refresh]);

  return { loading, paused: isPaused, finishedCount, error, setPaused, clearFinished };
}
