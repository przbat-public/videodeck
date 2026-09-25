import type { RecreateIndicesStatus } from '@videodeck/shared/api';
import { RecreateIndicesStatusSchema } from '@videodeck/shared/schemas';
import { useCallback, useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import i18n from '../i18n';
import { ApiRequestError, apiGet, apiSend } from '../utils/apiClient';
import { sleep } from '../utils/sleep';

interface UseRecreateIndicesResult {
  /** True from the click until the server reports the rebuild finished */
  loading: boolean;
  /** Last status received from the server (null before the first run) */
  status: RecreateIndicesStatus | null;
  recreateIndices: () => Promise<void>;
}

export const RECREATE_POLL_INTERVAL_MS = 1500;

async function fetchStatus(signal: AbortSignal): Promise<RecreateIndicesStatus> {
  return apiGet('/api/videos/recreateIndices/status', RecreateIndicesStatusSchema, {
    signal,
    failureMessage: (_failure, status) => i18n.t('errors.recreateStatus', { status }),
  });
}

/** Kicks the server-side rebuild off; a 409 means one is already running */
async function startRecreate(signal: AbortSignal, loadingToastId: string): Promise<void> {
  try {
    await apiSend('POST', '/api/videos/recreateIndices', null, undefined, {
      signal,
      failureMessage: (failure, status) => failure.message ?? `HTTP error! status: ${status}`,
    });
  } catch (err) {
    if (!(err instanceof ApiRequestError) || err.status !== 409) {
      throw err;
    }
    // A rebuild is already running; the poll below follows it to the end
    toast.loading(i18n.t('toast.recreateAlreadyRunning'), { id: loadingToastId });
  }
}

/** Follows the background rebuild until the server says it is done */
async function pollUntilFinished(
  signal: AbortSignal,
  loadingToastId: string,
  onStatus: (status: RecreateIndicesStatus) => void,
): Promise<RecreateIndicesStatus> {
  let current = await fetchStatus(signal);
  onStatus(current);
  while (current.running && !signal.aborted) {
    if (current.foldersTotal > 0) {
      toast.loading(
        i18n.t('toast.recreateProgress', { folder: current.foldersDone + 1, total: current.foldersTotal }),
        { id: loadingToastId },
      );
    }
    await sleep(RECREATE_POLL_INTERVAL_MS);
    if (signal.aborted) {
      return current; // unmounted mid-poll — the caller stops reporting
    }
    current = await fetchStatus(signal);
    onStatus(current);
  }
  return current;
}

/**
 * Rebuild all Elasticsearch indices. The POST only starts the server-side
 * job (202), so the hook follows /recreateIndices/status until the server
 * reports the run finished and only then reports success or failure —
 * no "done" toast while the rebuild is still running.
 */
export function useRecreateIndices(): UseRecreateIndicesResult {
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<RecreateIndicesStatus | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Unmount stops the polling loop: the next fetch rejects with AbortError
  // and the catch below exits silently.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const recreateIndices = useCallback(async (): Promise<void> => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    const loadingToastId = toast.loading(i18n.t('toast.recreateStarting'));

    try {
      await startRecreate(controller.signal, loadingToastId);
      const current = await pollUntilFinished(controller.signal, loadingToastId, setStatus);
      if (controller.signal.aborted) {
        return; // unmounted mid-poll — nothing to report
      }
      if (current.lastError || current.errors.length > 0) {
        toast.error(`${i18n.t('toast.recreateFailed')} ${current.lastError ?? ''}`.trim(), { id: loadingToastId });
      } else {
        toast.success(i18n.t('toast.recreateDone'), { id: loadingToastId });
      }
    } catch (err) {
      if (controller.signal.aborted) {
        return; // unmounted or superseded — nothing to report
      }
      const errorMessage = err instanceof Error ? err.message : i18n.t('errors.recreateStart');
      toast.error(errorMessage, { id: loadingToastId });
    } finally {
      setLoading(false);
    }
  }, []);

  return {
    loading,
    status,
    recreateIndices,
  };
}
