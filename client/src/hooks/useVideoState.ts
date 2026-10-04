import type { DownloadState, VideoStateResponse } from '@videodeck/shared/api';
import { VideoStateResponseSchema } from '@videodeck/shared/schemas';
import { useCallback, useEffect, useState } from 'react';
import i18n from '../i18n';
import { ApiRequestError, apiGet } from '../utils/apiClient';
import { logError } from '../utils/logError';

export interface UseVideoStateOptions {
  /** Only read while the panel is open; a closed panel asks for nothing */
  enabled?: boolean;
}

export interface UseVideoStateResult {
  state: DownloadState | null;
  /** False when the folder knows nothing about this video */
  known: boolean;
  loading: boolean;
  error: string | null;
}

/**
 * One video's file state, for the detail panel: `GET /api/folder/video-state`.
 * The list endpoint reports one row per video and stops there; the panel needs
 * the size, the archive flags and the missing list of a video the reader
 * opened, which is a read of its own.
 */
export function useVideoState(
  folderPath: string,
  videoId: string,
  options: UseVideoStateOptions = {},
): UseVideoStateResult {
  const { enabled = true } = options;
  const [state, setState] = useState<DownloadState | null>(null);
  const [known, setKnown] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (signal: AbortSignal): Promise<void> => {
      setLoading(true);
      try {
        const data: VideoStateResponse = await apiGet(
          `/api/folder/video-state?folderPath=${encodeURIComponent(folderPath)}&videoId=${encodeURIComponent(videoId)}`,
          VideoStateResponseSchema,
          {
            cache: 'no-store',
            signal,
            failureMessage: (failure) => failure.message ?? i18n.t('videoState.details.error'),
          },
        );
        if (!signal.aborted) {
          setState(data.state);
          setKnown(data.known);
          setError(null);
        }
      } catch (err) {
        if (signal.aborted) {
          return; // closed or moved to another row: the failure belongs to nobody
        }
        setState(null);
        setError(err instanceof ApiRequestError ? err.message : i18n.t('videoState.details.error'));
        logError(err);
      } finally {
        if (!signal.aborted) {
          setLoading(false);
        }
      }
    },
    [folderPath, videoId],
  );

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const controller = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mount/param fetch, the update lands after the await (see the rule note in eslint.config.mjs)
    void load(controller.signal);
    return () => {
      controller.abort();
    };
  }, [enabled, load]);

  // The panel follows the list: opening another row drops the state of the
  // previous one instead of showing its size under a new title.
  const currentKey = `${folderPath}|${videoId}`;
  const [resetKey, setResetKey] = useState(currentKey);
  if (currentKey !== resetKey) {
    setResetKey(currentKey);
    setState(null);
    setKnown(false);
    setError(null);
  }

  return { state, known, loading, error };
}
