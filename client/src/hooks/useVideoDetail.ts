import { useEffect, useReducer } from 'react';
import { VideoDetailsResponseSchema } from '@shared/schemas';
import type { VideoDetailState } from '../reducers/videoDetailReducer';
import {
  videoDetailReducer,
  initialState,
  VideoDetailActionType,
} from '../reducers/videoDetailReducer';

interface UseVideoDetailResult {
  state: VideoDetailState;
}

export function useVideoDetail(baseName: string | undefined): UseVideoDetailResult {
  const [state, dispatch] = useReducer(videoDetailReducer, initialState);

  useEffect(() => {
    if (!baseName) {
      dispatch({
        type: VideoDetailActionType.FETCH_ERROR,
        payload: 'Nieprawidłowy identyfikator filmu',
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
        if (!detailsResponse.ok) throw new Error('Failed to load video details');
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
          payload: err instanceof Error ? err.message : 'An error occurred',
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
