import { VideoListItem, VideoDetails } from '../types';

export interface VideoDetailState {
  video: VideoListItem | null;
  details: VideoDetails | null;
  loading: boolean;
  error: string | null;
}

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
    case 'FETCH_DETAILS_START':
      return {
        ...state,
        loading: true,
        error: null,
      };
    case 'FETCH_DETAILS_SUCCESS':
      return {
        ...state,
        details: action.payload,
        loading: false,
      };
    case 'FETCH_ERROR':
      return {
        ...state,
        error: action.payload,
        loading: false,
      };
    case 'RESET':
      return initialState;
    default:
      return state;
  }
}

