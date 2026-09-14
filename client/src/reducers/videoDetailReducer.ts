import type { VideoDetails, VideoListItem } from '@shared/api';

export interface VideoDetailState {
  video: VideoListItem | null;
  details: VideoDetails | null;
  loading: boolean;
  error: string | null;
}

export const VideoDetailActionType = {
  FETCH_DETAILS_START: 'FETCH_DETAILS_START',
  FETCH_DETAILS_SUCCESS: 'FETCH_DETAILS_SUCCESS',
  FETCH_ERROR: 'FETCH_ERROR',
  RESET: 'RESET',
} as const;
export type VideoDetailActionType =
  (typeof VideoDetailActionType)[keyof typeof VideoDetailActionType];

export type VideoDetailAction =
  | { type: 'FETCH_DETAILS_START' }
  | { type: 'FETCH_DETAILS_SUCCESS'; payload: VideoDetails }
  | { type: 'FETCH_ERROR'; payload: string }
  | { type: 'RESET' };

export const initialState: VideoDetailState = {
  video: null,
  details: null,
  loading: true,
  error: null,
};

export function videoDetailReducer(
  state: VideoDetailState,
  action: VideoDetailAction
): VideoDetailState {
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
    case VideoDetailActionType.RESET:
      return initialState;
    default:
      return state;
  }
}
