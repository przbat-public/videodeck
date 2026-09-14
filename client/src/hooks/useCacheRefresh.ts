import { useReducer, useCallback, useState } from 'react';
import toast from 'react-hot-toast';

import type { ReindexStatus } from '@shared/api';
import {
  cacheRefreshReducer,
  initialState,
  CacheRefreshActionType,
} from '../reducers/cacheRefreshReducer';

interface UseCacheRefreshResult {
  /** True from the click until the server reports the reindex finished */
  loading: boolean;
  /** Last status received from the server (null before the first run) */
  status: ReindexStatus | null;
  refreshCache: () => Promise<void>;
}

export interface UseCacheRefreshOptions {
  pollIntervalMs?: number;
}

export const DEFAULT_POLL_INTERVAL_MS = 2000;

function folderName(folderPath?: string): string {
  if (!folderPath) return '';
  const parts = folderPath.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? folderPath;
}

/** One-line progress text for the loading toast */
export function formatReindexProgress(status: ReindexStatus): string {
  const folder = folderName(status.currentFolder);
  const folderPart =
    status.foldersTotal > 0 ? `folder ${status.foldersDone + 1}/${status.foldersTotal}` : '';
  const filesPart = status.filesTotal > 0 ? `${status.filesDone}/${status.filesTotal} plików` : '';
  const parts = [
    'Indeksowanie',
    folderPart,
    folder,
    filesPart,
    `${status.indexed} zindeksowanych`,
  ].filter(Boolean);
  return parts.join(' · ');
}

/** Final message once the run is over */
export function formatReindexResult(status: ReindexStatus): string {
  const base = `Indeksowanie zakończone: ${status.indexed} filmów zindeksowanych`;
  const skipped = status.skipped > 0 ? `, ${status.skipped} pominiętych` : '';
  const errors =
    status.errors.length > 0
      ? `, ${status.errors.length} ${status.errors.length === 1 ? 'błąd folderu' : 'błędów folderów'}`
      : '';
  return `${base}${skipped}${errors}`;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function fetchStatus(): Promise<ReindexStatus> {
  const response = await fetch('/api/videos/refreshCache/status');
  if (!response.ok) {
    throw new Error(`Nie udało się odczytać statusu indeksowania (HTTP ${response.status})`);
  }
  return response.json();
}

export function useCacheRefresh(options: UseCacheRefreshOptions = {}): UseCacheRefreshResult {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const [state, dispatch] = useReducer(cacheRefreshReducer, initialState);
  const [status, setStatus] = useState<ReindexStatus | null>(null);

  const refreshCache = useCallback(async (): Promise<void> => {
    dispatch({ type: CacheRefreshActionType.REFRESH_START });
    const loadingToastId = toast.loading('Rozpoczynanie odświeżania indeksu...');

    try {
      const response = await fetch('/api/videos/refreshCache');

      if (!response.ok && response.status !== 409) {
        const errorData = await response.json().catch(() => ({ message: 'Unknown error' }));
        throw new Error(errorData.message || `HTTP error! status: ${response.status}`);
      }

      if (response.status === 409) {
        toast.loading('Indeksowanie już trwa — śledzę postęp...', { id: loadingToastId });
      }

      // Follow the background job until the server says it is done
      let current = await fetchStatus();
      setStatus(current);
      while (current.running) {
        toast.loading(formatReindexProgress(current), { id: loadingToastId });
        await sleep(pollIntervalMs);
        current = await fetchStatus();
        setStatus(current);
      }

      const summary = formatReindexResult(current);
      if (current.errors.length > 0) {
        dispatch({ type: CacheRefreshActionType.REFRESH_ERROR, payload: summary });
        toast.error(`${summary}. ${current.lastError ?? ''}`.trim(), { id: loadingToastId });
      } else {
        dispatch({ type: CacheRefreshActionType.REFRESH_SUCCESS, payload: summary });
        toast.success(summary, { id: loadingToastId });
      }
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : 'Nie udało się rozpocząć odświeżania indeksu';
      dispatch({
        type: CacheRefreshActionType.REFRESH_ERROR,
        payload: errorMessage,
      });

      toast.error(errorMessage, { id: loadingToastId });
    }
  }, [pollIntervalMs]);

  return {
    loading: state.loading,
    status,
    refreshCache,
  };
}
