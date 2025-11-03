import { useEffect, useReducer } from 'react';
import {
  videoDetailReducer,
  initialState,
  VideoDetailState,
  VideoDetailActionType,
} from '../reducers/videoDetailReducer';

interface UseVideoDetailResult {
  state: VideoDetailState;
}

export function useVideoDetail(baseName: string | undefined): UseVideoDetailResult {
  const [state, dispatch] = useReducer(videoDetailReducer, initialState);

  useEffect(() => {
    if (!baseName) {
      dispatch({ type: VideoDetailActionType.FETCH_ERROR, payload: 'Invalid video ID' });
      return;
    }

    const fetchVideoDetail = async () => {
      try {
        dispatch({ type: VideoDetailActionType.FETCH_DETAILS_START });
        const detailsResponse = await fetch(
          `/api/videos/${encodeURIComponent(baseName)}/details`
        );
        if (!detailsResponse.ok) throw new Error('Failed to load video details');
        const detailsData = await detailsResponse.json();
        dispatch({ type: VideoDetailActionType.FETCH_DETAILS_SUCCESS, payload: detailsData.details });
      } catch (err) {
        dispatch({
          type: VideoDetailActionType.FETCH_ERROR,
          payload: err instanceof Error ? err.message : 'An error occurred',
        });
      }
    };

    fetchVideoDetail();
  }, [baseName]);

  return { state };
}

