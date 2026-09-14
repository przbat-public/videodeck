import { useEffect, useReducer } from 'react';
import i18n from '../i18n';
import { VideoSummaryResponseSchema } from '@shared/schemas';
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
      const loadingToastId = toast.loading(i18n.t('toast.summaryStarting'));

      try {
        dispatch({ type: VideoSummaryActionType.FETCH_SUMMARY_START });
        const summaryResponse = await fetch(`/api/videos/${encodeURIComponent(baseName)}/summary`, {
          signal: controller.signal,
        });
        if (!summaryResponse.ok) {
          throw new Error('Failed to load summary');
        }
        const summaryData = VideoSummaryResponseSchema.parse(await summaryResponse.json());
        dispatch({
          type: VideoSummaryActionType.FETCH_SUMMARY_SUCCESS,
          payload: summaryData.summary,
        });

        toast.success(i18n.t('toast.summaryDone'), { id: loadingToastId });
      } catch (err) {
        if (controller.signal.aborted) {
          return; // unmounted / superseded — nothing to report
        }
        const errorMessage = err instanceof Error ? err.message : i18n.t('errors.occurred');
        dispatch({
          type: VideoSummaryActionType.FETCH_SUMMARY_ERROR,
          payload: errorMessage,
        });

        toast.error(i18n.t('toast.summaryFailed'), { id: loadingToastId });
      }
    };

    void fetchSummary();
    return () => {
      controller.abort();
    };
  }, [baseName, subtitlePath]);

  return { state };
}
