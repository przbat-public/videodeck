import { VideoDetailsResponseSchema } from '@videodeck/shared/schemas';
import { useEffect, useReducer } from 'react';
import i18n from '../i18n';
import type { VideoDetailState } from '../reducers/videoDetailReducer';
import { initialState, VideoDetailActionType, videoDetailReducer } from '../reducers/videoDetailReducer';

interface UseVideoDetailResult {
  state: VideoDetailState;
}

export function useVideoDetail(baseName: string | undefined): UseVideoDetailResult {
  const [state, dispatch] = useReducer(videoDetailReducer, initialState);

  useEffect(() => {
    if (!baseName) {
      dispatch({
        type: VideoDetailActionType.FETCH_ERROR,
        payload: i18n.t('video.invalidId'),
      });
      return;
    }

    const controller = new AbortController();
    const fetchVideoDetail = async () => {
      try {
        dispatch({ type: VideoDetailActionType.FETCH_DETAILS_START });
        const detailsResponse = await fetch(`/api/videos/${encodeURIComponent(baseName)}/details`, {
          signal: controller.signal,
        });
        if (!detailsResponse.ok) throw new Error(i18n.t('errors.loadDetails'));
        const detailsData = VideoDetailsResponseSchema.parse(await detailsResponse.json());
        dispatch({
          type: VideoDetailActionType.FETCH_DETAILS_SUCCESS,
          payload: detailsData.details,
        });
      } catch (err) {
        if (controller.signal.aborted) {
          return; // unmounted / superseded — nothing to report
        }
        dispatch({
          type: VideoDetailActionType.FETCH_ERROR,
          payload: err instanceof Error ? err.message : i18n.t('errors.occurred'),
        });
      }
    };

    void fetchVideoDetail();
    return () => {
      controller.abort();
    };
  }, [baseName]);

  return { state };
}
