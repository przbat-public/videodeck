import type { VideoListItem } from '@shared/api';

export interface VideoSearchState {
  videos: VideoListItem[];
  totalCount: number;
  loading: boolean;
  error: string | null;
}

export const VideoSearchActionType = {
  SEARCH_START: 'SEARCH_START',
  SEARCH_SUCCESS: 'SEARCH_SUCCESS',
  SEARCH_ERROR: 'SEARCH_ERROR',
} as const;
export type VideoSearchActionType =
  (typeof VideoSearchActionType)[keyof typeof VideoSearchActionType];

export type VideoSearchAction =
  | { type: 'SEARCH_START' }
  | {
      type: 'SEARCH_SUCCESS';
      payload: { videos: VideoListItem[]; totalCount: number; append?: boolean };
    }
  | { type: 'SEARCH_ERROR'; payload: string };

export const initialState: VideoSearchState = {
  videos: [],
  totalCount: 0,
  loading: false,
  error: null,
};

export function videoSearchReducer(
  state: VideoSearchState,
  action: VideoSearchAction
): VideoSearchState {
  switch (action.type) {
    case VideoSearchActionType.SEARCH_START:
      return {
        ...state,
        loading: true,
        error: null,
      };
    case VideoSearchActionType.SEARCH_SUCCESS:
      return {
        ...state,
        // `append` accumulates a "load more" page onto the current results
        videos: action.payload.append
          ? [...state.videos, ...action.payload.videos]
          : action.payload.videos,
        totalCount: action.payload.totalCount,
        loading: false,
      };
    case VideoSearchActionType.SEARCH_ERROR:
      return {
        ...state,
        error: action.payload,
        videos: [],
        totalCount: 0,
        loading: false,
      };
    default:
      return state;
  }
}
