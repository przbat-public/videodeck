import type { VideoDetails } from '@videodeck/shared/api';

export interface VideoDetailState {
  details: VideoDetails | null;
  loading: boolean;
  error: string | null;
}

export const VideoDetailActionType = {
  FETCH_DETAILS_START: 'FETCH_DETAILS_START',
  FETCH_DETAILS_SUCCESS: 'FETCH_DETAILS_SUCCESS',
  FETCH_ERROR: 'FETCH_ERROR',
} as const;
export type VideoDetailActionType = (typeof VideoDetailActionType)[keyof typeof VideoDetailActionType];

export type VideoDetailAction =
  | { type: 'FETCH_DETAILS_START' }
  | { type: 'FETCH_DETAILS_SUCCESS'; payload: VideoDetails }
  | { type: 'FETCH_ERROR'; payload: string };

export const initialState: VideoDetailState = {
  details: null,
  loading: true,
  error: null,
};

export function videoDetailReducer(state: VideoDetailState, action: VideoDetailAction): VideoDetailState {
  switch (action.type) {
    case VideoDetailActionType.FETCH_DETAILS_START:
      return {
        ...state,
        loading: true,
        error: null,
      };
    case VideoDetailActionType.FETCH_DETAILS_SUCCESS:
      return {
        ...state,
        details: action.payload,
        loading: false,
      };
    case VideoDetailActionType.FETCH_ERROR:
      return {
        ...state,
        error: action.payload,
        loading: false,
      };
    default:
      return state;
  }
}
