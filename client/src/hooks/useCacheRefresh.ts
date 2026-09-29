import type { ReindexStatus } from '@videodeck/shared/api';
import { useCallback, useSyncExternalStore } from 'react';
import {
  DEFAULT_POLL_INTERVAL_MS,
  formatReindexMenuLabel,
  formatReindexProgress,
  formatReindexResult,
  getReindexState,
  refreshCache as startReindexRun,
  subscribeReindexState,
} from '../utils/reindexStore';

/**
 * Reads the reindex run from its store. The run itself (the poller, the toast,
 * the single-flight) lives in `utils/reindexStore.ts`, because the shell's
 * arrival notice and the results page both watch it, and hook-local state gave
 * each of them its own copy of the same server job.
 */

interface UseCacheRefreshResult {
  /** True from the click until the server reports the reindex finished */
  loading: boolean;
  /** Last status received from the server (null before the first run) */
  status: ReindexStatus | null;
  /**
   * Start a reindex, or join the one already running. With `onlyMissing`,
   * folders that already have a cache in Elasticsearch (e.g. the disk plugged
   * in earlier) are skipped and keep serving searches.
   */
  refreshCache: (options?: { onlyMissing?: boolean }) => Promise<void>;
}

export interface UseCacheRefreshOptions {
  pollIntervalMs?: number;
}

export { DEFAULT_POLL_INTERVAL_MS, formatReindexMenuLabel, formatReindexProgress, formatReindexResult };

export function useCacheRefresh(options: UseCacheRefreshOptions = {}): UseCacheRefreshResult {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const state = useSyncExternalStore(subscribeReindexState, getReindexState, getReindexState);

  const refreshCache = useCallback(
    (run?: { onlyMissing?: boolean }): Promise<void> => startReindexRun({ ...run, pollIntervalMs }),
    [pollIntervalMs],
  );

  return {
    loading: state.loading,
    status: state.status,
    refreshCache,
  };
}
