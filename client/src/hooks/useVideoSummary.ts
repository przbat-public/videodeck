import { useEffect, useReducer } from 'react';
import type { VideoSummaryResponse } from '@shared/api';
import toast from 'react-hot-toast';
import type { VideoSummaryState } from '../reducers/videoSummaryReducer';
import {
  videoSummaryReducer,
  initialState,
  VideoSummaryActionType,
} from '../reducers/videoSummaryReducer';

interface UseVideoSummaryResult {
  state: VideoSummaryState;
}

export function useVideoSummary(
  baseName: string | undefined,
  subtitlePath: string | undefined
): UseVideoSummaryResult {
  const [state, dispatch] = useReducer(videoSummaryReducer, initialState);

  useEffect(() => {
    if (!baseName || !subtitlePath) {
      return;
    }

    const fetchSummary = async () => {
      const loadingToastId = toast.loading('Started generating summary...');

      try {
        dispatch({ type: VideoSummaryActionType.FETCH_SUMMARY_START });
        const summaryResponse = await fetch(`/api/videos/${encodeURIComponent(baseName)}/summary`);
        if (!summaryResponse.ok) {
          throw new Error('Failed to load summary');
        }
        const summaryData: VideoSummaryResponse = await summaryResponse.json();
        dispatch({
          type: VideoSummaryActionType.FETCH_SUMMARY_SUCCESS,
          payload: summaryData.summary,
        });

        // Update toast to success
        toast.success('Summary generated successfully', { id: loadingToastId });
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'An error occurred';
        dispatch({
          type: VideoSummaryActionType.FETCH_SUMMARY_ERROR,
          payload: errorMessage,
        });

        // Update toast to error
        toast.error('Failed to generate summary', { id: loadingToastId });
      }
    };

    fetchSummary();
  }, [baseName, subtitlePath]);

  return { state };
}
