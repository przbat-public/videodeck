import type { ReindexStatus } from '@videodeck/shared/api';
import { ReindexStatusSchema } from '@videodeck/shared/schemas';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import i18n from '../i18n';
import { CacheRefreshActionType, cacheRefreshReducer, initialState } from '../reducers/cacheRefreshReducer';
import { sleep } from '../utils/sleep';

interface UseCacheRefreshResult {
  /** True from the click until the server reports the reindex finished */
  loading: boolean;
  /** Last status received from the server (null before the first run) */
  status: ReindexStatus | null;
  /**
   * Start a reindex. With `onlyMissing`, folders that already have a cache
   * in Elasticsearch (e.g. the disk plugged in earlier) are skipped and
   * keep serving searches.
   */
  refreshCache: (options?: { onlyMissing?: boolean }) => Promise<void>;
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
  const folderPart =
    status.foldersTotal > 0
      ? i18n.t('reindex.progressFolder', {
          folder: status.foldersDone + 1,
          total: status.foldersTotal,
        })
      : '';
  const filesPart =
    status.filesTotal > 0
      ? i18n.t('reindex.progressFiles', {
          filesDone: status.filesDone,
          filesTotal: status.filesTotal,
        })
      : '';
  const parts = [
    i18n.t('reindex.progressLabel'),
    folderPart,
    folderName(status.currentFolder),
    filesPart,
    i18n.t('reindex.progressIndexed', { count: status.indexed }),
  ].filter(Boolean);
  return parts.join(' · ');
}

/** Final message once the run is over */
export function formatReindexResult(status: ReindexStatus): string {
  // A skipped run (onlyMissing with every folder cached) scans nothing
  if (status.foldersTotal === 0 && status.indexed === 0) {
    return i18n.t('reindex.nothingToDo');
  }
  const base = i18n.t(status.skipped > 0 ? 'reindex.finishedWithSkipped' : 'reindex.finished', {
    indexed: status.indexed,
    skipped: status.skipped,
  });
  const errors = status.errors.length > 0 ? `, ${i18n.t('reindex.folderError', { count: status.errors.length })}` : '';
  return `${base}${errors}`;
}

async function fetchStatus(signal: AbortSignal): Promise<ReindexStatus> {
  const response = await fetch('/api/videos/refreshCache/status', { signal });
  if (!response.ok) {
    throw new Error(i18n.t('reindex.statusFailed', { status: response.status }));
  }
  return ReindexStatusSchema.parse(await response.json());
}

/** Kicks the server-side run off; a 409 means one is already running */
async function startReindex(url: string, signal: AbortSignal, loadingToastId: string): Promise<void> {
  const response = await fetch(url, { method: 'POST', signal });

  if (!response.ok && response.status !== 409) {
    const errorData = await response.json().catch(() => ({ message: 'Unknown error' }));
    throw new Error(errorData.message || `HTTP error! status: ${response.status}`);
  }

  if (response.status === 409) {
    toast.loading(i18n.t('reindex.alreadyRunning'), { id: loadingToastId });
  }
}

/** Follows the background job until the server says it is done */
async function pollReindexUntilFinished(
  signal: AbortSignal,
  pollIntervalMs: number,
  loadingToastId: string,
  onStatus: (status: ReindexStatus) => void,
): Promise<ReindexStatus> {
  let current = await fetchStatus(signal);
  onStatus(current);
  while (current.running && !signal.aborted) {
    toast.loading(formatReindexProgress(current), { id: loadingToastId });
    await sleep(pollIntervalMs);
    if (signal.aborted) {
      return current; // unmounted mid-poll — the caller stops reporting
    }
    current = await fetchStatus(signal);
    onStatus(current);
  }
  return current;
}

export function useCacheRefresh(options: UseCacheRefreshOptions = {}): UseCacheRefreshResult {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const [state, dispatch] = useReducer(cacheRefreshReducer, initialState);
  const [status, setStatus] = useState<ReindexStatus | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Unmount stops the polling loop: the next fetch rejects with AbortError
  // and the catch below exits silently.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const refreshCache = useCallback(
    async (options?: { onlyMissing?: boolean }): Promise<void> => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      dispatch({ type: CacheRefreshActionType.REFRESH_START });
      const loadingToastId = toast.loading(i18n.t('reindex.starting'));

      try {
        const url = options?.onlyMissing ? '/api/videos/refreshCache?onlyMissing=1' : '/api/videos/refreshCache';
        await startReindex(url, controller.signal, loadingToastId);

        const current = await pollReindexUntilFinished(controller.signal, pollIntervalMs, loadingToastId, setStatus);
        if (controller.signal.aborted) {
          return; // unmounted mid-poll — nothing to report
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
        if (controller.signal.aborted) {
          return; // unmounted or superseded — nothing to report
        }
        const errorMessage = err instanceof Error ? err.message : i18n.t('reindex.startFailed');
        dispatch({
          type: CacheRefreshActionType.REFRESH_ERROR,
          payload: errorMessage,
        });

        toast.error(errorMessage, { id: loadingToastId });
      }
    },
    [pollIntervalMs],
  );

  return {
    loading: state.loading,
    status,
    refreshCache,
  };
}
