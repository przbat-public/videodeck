import { VideoSummaryResponseSchema } from '@videodeck/shared/schemas';
import { useEffect, useReducer, useState } from 'react';
import toast from 'react-hot-toast';
import i18n from '../i18n';
import type { VideoSummaryState } from '../reducers/videoSummaryReducer';
import { initialState, VideoSummaryActionType, videoSummaryReducer } from '../reducers/videoSummaryReducer';

/** The distinct, actionable message shown when the server has no OpenAI key */
function summaryUnavailableMessage(): string {
  return i18n.t('toast.summaryUnavailable');
}

type SummaryFetchResult =
  | { kind: 'success'; summary: string; truncated: boolean }
  | { kind: 'unavailable'; message: string }
  | { kind: 'quiet' };

/** One summary request, mapped to an outcome the effect can dispatch simply */
async function requestSummary(baseName: string, signal: AbortSignal): Promise<SummaryFetchResult> {
  const response = await fetch(`/api/videos/${encodeURIComponent(baseName)}/summary`, { signal });
  if (response.status === 404) {
    // No subtitle file for this video — nothing to summarize, not an error
    return { kind: 'quiet' };
  }
  if (response.status === 503) {
    // The server has no OPENAI_API_KEY configured — surface that
    // specifically instead of the generic failure toast.
    return { kind: 'unavailable', message: summaryUnavailableMessage() };
  }
  if (!response.ok) {
    throw new Error('Failed to load summary');
  }
  const data = VideoSummaryResponseSchema.parse(await response.json());
  return { kind: 'success', summary: data.summary, truncated: data.truncated === true };
}

interface UseVideoSummaryResult {
  state: VideoSummaryState;
  /** True when the summary was generated from subtitles cut to the token limit */
  truncated: boolean;
}

/**
 * Fetch (and, when nothing is cached, generate) the AI summary of a video.
 * Quiet for videos without subtitles (404), loud about a disabled OpenAI key
 * (503 — a distinct, actionable message) and honest about truncation.
 */
export function useVideoSummary(baseName: string | undefined, subtitlePath: string | undefined): UseVideoSummaryResult {
  const [state, dispatch] = useReducer(videoSummaryReducer, initialState);
  const [truncated, setTruncated] = useState(false);

  useEffect(() => {
    if (!baseName || !subtitlePath) {
      return;
    }

    const controller = new AbortController();
    const fetchSummary = async () => {
      const loadingToastId = toast.loading(i18n.t('toast.summaryStarting'));

      try {
        dispatch({ type: VideoSummaryActionType.FETCH_SUMMARY_START });
        const result = await requestSummary(baseName, controller.signal);
        switch (result.kind) {
          case 'quiet':
            dispatch({ type: VideoSummaryActionType.RESET });
            toast.dismiss(loadingToastId);
            return;
          case 'unavailable':
            dispatch({ type: VideoSummaryActionType.FETCH_SUMMARY_ERROR, payload: result.message });
            toast.error(result.message, { id: loadingToastId });
            return;
          case 'success':
            dispatch({ type: VideoSummaryActionType.FETCH_SUMMARY_SUCCESS, payload: result.summary });
            setTruncated(result.truncated);
            toast.success(i18n.t('toast.summaryDone'), { id: loadingToastId });
            return;
        }
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

  return { state, truncated };
}
