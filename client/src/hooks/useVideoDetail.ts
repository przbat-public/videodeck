import { VideoDetailsResponseSchema } from '@videodeck/shared/schemas';
import { useCallback, useEffect, useReducer } from 'react';
import i18n from '../i18n';
import type { VideoDetailState } from '../reducers/videoDetailReducer';
import { initialState, VideoDetailActionType, videoDetailReducer } from '../reducers/videoDetailReducer';
import { apiGet } from '../utils/apiClient';

interface UseVideoDetailResult {
  state: VideoDetailState;
  /** Ask for the details again after a failed load (the retry button) */
  reload: () => void;
}

export function useVideoDetail(baseName: string | undefined): UseVideoDetailResult {
  const [state, dispatch] = useReducer(videoDetailReducer, initialState);

  const load = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      if (!baseName) {
        dispatch({
          type: VideoDetailActionType.FETCH_ERROR,
          payload: i18n.t('video.invalidId'),
        });
        return;
      }
      try {
        dispatch({ type: VideoDetailActionType.FETCH_DETAILS_START });
        const detailsData = await apiGet(
          `/api/videos/${encodeURIComponent(baseName)}/details`,
          VideoDetailsResponseSchema,
          {
            ...(signal ? { signal } : {}),
            message: i18n.t('errors.loadDetails'),
          },
        );
        dispatch({
          type: VideoDetailActionType.FETCH_DETAILS_SUCCESS,
          payload: detailsData.details,
        });
      } catch (err) {
        if (signal?.aborted) {
          return; // unmounted / superseded — nothing to report
        }
        dispatch({
          type: VideoDetailActionType.FETCH_ERROR,
          payload: err instanceof Error ? err.message : i18n.t('errors.occurred'),
        });
      }
    },
    [baseName],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => {
      controller.abort();
    };
  }, [load]);

  const reload = useCallback((): void => {
    void load();
  }, [load]);

  return { state, reload };
}
