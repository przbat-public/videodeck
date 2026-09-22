import type { FolderSummary } from '@videodeck/shared/api';
import { FolderSummariesResponseSchema } from '@videodeck/shared/schemas';
import { useCallback, useEffect, useState } from 'react';
import i18n from '../i18n';
import { logError } from '../utils/logError';

interface UseFolderSummariesResult {
  /** Counts per folder path; empty until the endpoint answers */
  summaries: Record<string, FolderSummary>;
  loading: boolean;
  error: string | null;
  /** Ask again after a failure */
  reload: () => void;
  /**
   * Re-read the counts of these folders alone and merge them in. Meant for
   * the folders whose job just finished: two disk reads each instead of two
   * per configured folder. A failure keeps the previous counts and raises no
   * banner, since the full load already succeeded.
   */
  refreshFolders: (folderPaths: readonly string[]) => Promise<void>;
}

/** GET one folder's counts; the response carries that folder alone */
async function fetchFolderSummary(folderPath: string): Promise<Record<string, FolderSummary>> {
  const response = await fetch(`/api/folder/summaries?folderPath=${encodeURIComponent(folderPath)}`, {
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new Error(i18n.t('errors.loadSummaries'));
  }
  return FolderSummariesResponseSchema.parse(await response.json()).summaries;
}

/**
 * Counts behind the channel console: how many videos each channel has, how
 * many are missing and how many downloads are stale. The table renders without
 * them (the columns show a dash) and fills in when they arrive, so a slow disk
 * never holds the page.
 */
export function useFolderSummaries(enabled = true): UseFolderSummariesResult {
  const [summaries, setSummaries] = useState<Record<string, FolderSummary>>({});
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal): Promise<void> => {
    setFetching(true);
    try {
      const response = await fetch('/api/folder/summaries', signal ? { signal } : {});
      if (!response.ok) {
        throw new Error(i18n.t('errors.loadSummaries'));
      }
      const data = FolderSummariesResponseSchema.parse(await response.json());
      setSummaries(data.summaries);
      setError(null);
    } catch (err) {
      if (signal?.aborted) {
        return; // unmounted: the failure belongs to nobody
      }
      setError(err instanceof Error ? err.message : i18n.t('errors.occurred'));
    } finally {
      if (!signal?.aborted) {
        setFetching(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const controller = new AbortController();
    void load(controller.signal);
    return () => {
      controller.abort();
    };
  }, [enabled, load]);

  const reload = useCallback((): void => {
    void load();
  }, [load]);

  const refreshFolders = useCallback(async (folderPaths: readonly string[]): Promise<void> => {
    const results = await Promise.allSettled(folderPaths.map(fetchFolderSummary));
    const fresh: Record<string, FolderSummary> = {};
    for (const result of results) {
      if (result.status === 'fulfilled') {
        Object.assign(fresh, result.value);
      } else {
        logError(result.reason);
      }
    }
    if (Object.keys(fresh).length > 0) {
      setSummaries((previous) => ({ ...previous, ...fresh }));
    }
  }, []);

  // Derived, not stored: a disabled hook is never loading, and the effect
  // does not have to reset a state it is not allowed to touch.
  return { summaries, loading: enabled && fetching, error, reload, refreshFolders };
}
