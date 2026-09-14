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

    const controller = new AbortController();
    const fetchSummary = async () => {
      const loadingToastId = toast.loading('Generowanie streszczenia...');

      try {
        dispatch({ type: VideoSummaryActionType.FETCH_SUMMARY_START });
        const summaryResponse = await fetch(`/api/videos/${encodeURIComponent(baseName)}/summary`, {
          signal: controller.signal,
        });
        if (!summaryResponse.ok) {
          throw new Error('Failed to load summary');
        }
        const summaryData: VideoSummaryResponse = await summaryResponse.json();
        dispatch({
          type: VideoSummaryActionType.FETCH_SUMMARY_SUCCESS,
          payload: summaryData.summary,
        });

        toast.success('Streszczenie gotowe', { id: loadingToastId });
      } catch (err) {
        if (controller.signal.aborted) {
          return; // unmounted / superseded — nothing to report
        }
        const errorMessage = err instanceof Error ? err.message : 'An error occurred';
        dispatch({
          type: VideoSummaryActionType.FETCH_SUMMARY_ERROR,
          payload: errorMessage,
        });

        toast.error('Nie udało się wygenerować streszczenia', { id: loadingToastId });
      }
    };

    void fetchSummary();
    return () => {
      controller.abort();
    };
  }, [baseName, subtitlePath]);

  return { state };
}
