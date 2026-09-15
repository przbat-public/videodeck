export interface VideoSummaryState {
  summary: string | null;
  loading: boolean;
  error: string | null;
}

export const VideoSummaryActionType = {
  FETCH_SUMMARY_START: 'FETCH_SUMMARY_START',
  FETCH_SUMMARY_SUCCESS: 'FETCH_SUMMARY_SUCCESS',
  FETCH_SUMMARY_ERROR: 'FETCH_SUMMARY_ERROR',
  RESET: 'RESET',
} as const;
export type VideoSummaryActionType = (typeof VideoSummaryActionType)[keyof typeof VideoSummaryActionType];

export type VideoSummaryAction =
  | { type: 'FETCH_SUMMARY_START' }
  | { type: 'FETCH_SUMMARY_SUCCESS'; payload: string }
  | { type: 'FETCH_SUMMARY_ERROR'; payload: string }
  | { type: 'RESET' };

export const initialState: VideoSummaryState = {
  summary: null,
  loading: false,
  error: null,
};

export function videoSummaryReducer(state: VideoSummaryState, action: VideoSummaryAction): VideoSummaryState {
  switch (action.type) {
    case VideoSummaryActionType.FETCH_SUMMARY_START:
      return {
        ...state,
        loading: true,
        error: null,
      };
    case VideoSummaryActionType.FETCH_SUMMARY_SUCCESS:
      return {
        ...state,
        summary: action.payload,
        loading: false,
        error: null,
      };
    case VideoSummaryActionType.FETCH_SUMMARY_ERROR:
      return {
        ...state,
        loading: false,
        error: action.payload,
      };
    case VideoSummaryActionType.RESET:
      return initialState;
    default:
      return state;
  }
}
