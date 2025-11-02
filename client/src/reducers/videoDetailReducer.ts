import { VideoInfo } from '../hooks/useVideoSearch';
import { Comment } from '../types';

export interface VideoDetails {
  title: string;
  description: string;
  uploadDate: string;
  duration: string;
  viewCount: number;
  likeCount: number;
  channel: string;
  comments: Comment[];
  commentCount: number;
  videoPath: string;
  thumbnailPath: string;
}

export interface VideoDetailState {
  video: VideoInfo | null;
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

