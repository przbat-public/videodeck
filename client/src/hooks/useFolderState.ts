import type { FolderStateResponse } from '@videodeck/shared/api';
import { FolderStateResponseSchema } from '@videodeck/shared/schemas';
import { useCallback, useEffect, useRef, useState } from 'react';
import i18n from '../i18n';
import { ApiRequestError, apiGet } from '../utils/apiClient';
import { logError } from '../utils/logError';
import type { VideoStateFilter } from '../utils/videoState';

export interface UseFolderStateOptions {
  /** What the server should answer with; the chips set it */
  filter?: VideoStateFilter;
  /** Skip the read: a folder with no list to show has nothing to ask about */
  enabled?: boolean;
}

export interface UseFolderStateResult {
  /** null until the current folder and filter have an answer */
  state: FolderStateResponse | null;
  loading: boolean;
  error: string | null;
  /** Read the same folder and filter again, after a job changed the disk */
  refresh: () => void;
}

/**
 * What the folder holds per video: the badges, the missing lists, the orphans
 * and the archive drift, in one read of `GET /api/folder/state`. The video
 * list itself still comes from `GET /api/folder/list`; this hook answers the
 * question that endpoint cannot, and joins its rows by video id.
 *
 * The filter is the server's own (`?filter=`), so the counts in the response
 * stay the folder's totals while the rows follow the chip.
 */
export function useFolderState(folderPath: string, options: UseFolderStateOptions = {}): UseFolderStateResult {
  const { filter = 'all', enabled = true } = options;
  const [state, setState] = useState<FolderStateResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (signal: AbortSignal): Promise<void> => {
      setLoading(true);
      try {
        const data = await apiGet(
          `/api/folder/state?folderPath=${encodeURIComponent(folderPath)}&filter=${filter}`,
          FolderStateResponseSchema,
          { cache: 'no-store', signal, failureMessage: (failure) => failure.message ?? i18n.t('videoState.loadError') },
        );
        if (!signal.aborted) {
          setState(data);
          setError(null);
        }
      } catch (err) {
        if (signal.aborted) {
          return; // unmounted or superseded: the failure belongs to nobody
        }
        // The server's own wording when it answered at all; a body that does not
        // match the contract is a parse error nobody can read, so it gets the
        // folder-state sentence instead.
        setError(err instanceof ApiRequestError ? err.message : i18n.t('videoState.loadError'));
        logError(err);
      } finally {
        if (!signal.aborted) {
          setLoading(false);
        }
      }
    },
    [filter, folderPath],
  );

  // The read in flight, so a refresh or a parameter change can cancel it. The
  // refresh runs the read itself instead of bumping a counter the effect
  // watches: that counter bought an extra render and a dependency the linter
  // rightly flagged as unused.
  const controllerRef = useRef<AbortController | null>(null);
  const read = useCallback((): void => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    void load(controller.signal);
  }, [load]);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mount/param fetch, the update lands after the await (see the rule note in eslint.config.mjs)
    read();
    return () => {
      controllerRef.current?.abort();
    };
  }, [enabled, read]);

  // Another folder or another filter: the answer on screen belongs to the
  // previous question, so it is dropped during render rather than shown
  // against the new rows for a frame.
  const currentKey = `${folderPath}|${filter}`;
  const [resetKey, setResetKey] = useState(currentKey);
  if (currentKey !== resetKey) {
    setResetKey(currentKey);
    setState(null);
    setError(null);
  }

  return { state, loading, error, refresh: read };
}
