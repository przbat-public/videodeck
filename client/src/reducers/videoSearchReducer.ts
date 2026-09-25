import type { VideoListItem } from '@videodeck/shared/api';

export interface VideoSearchState {
  videos: VideoListItem[];
  totalCount: number;
  loading: boolean;
  /**
   * A "load more" page is in flight. Kept apart from `loading` because the
   * cards on screen already answer the current query: only the list region is
   * busy, and the page must not announce a fresh load for every page.
   */
  loadingMore: boolean;
  error: string | null;
}

export const VideoSearchActionType = {
  SEARCH_START: 'SEARCH_START',
  SEARCH_SUCCESS: 'SEARCH_SUCCESS',
  SEARCH_ERROR: 'SEARCH_ERROR',
} as const;
export type VideoSearchActionType = (typeof VideoSearchActionType)[keyof typeof VideoSearchActionType];

export type VideoSearchAction =
  | { type: 'SEARCH_START'; payload: { append: boolean } }
  | {
      type: 'SEARCH_SUCCESS';
      payload: { videos: VideoListItem[]; totalCount: number; append?: boolean };
    }
  | { type: 'SEARCH_ERROR'; payload: { message: string; append?: boolean } };

export const initialState: VideoSearchState = {
  videos: [],
  totalCount: 0,
  loading: false,
  loadingMore: false,
  error: null,
};

export function videoSearchReducer(state: VideoSearchState, action: VideoSearchAction): VideoSearchState {
  switch (action.type) {
    case VideoSearchActionType.SEARCH_START:
      return {
        ...state,
        loading: !action.payload.append,
        loadingMore: action.payload.append,
        error: null,
      };
    case VideoSearchActionType.SEARCH_SUCCESS:
      return {
        ...state,
        // `append` accumulates a "load more" page onto the current results
        videos: action.payload.append ? [...state.videos, ...action.payload.videos] : action.payload.videos,
        totalCount: action.payload.totalCount,
        loading: false,
        loadingMore: false,
      };
    case VideoSearchActionType.SEARCH_ERROR:
      return {
        ...state,
        error: action.payload.message,
        // A failed "load more" keeps the pages already on screen so the user
        // can retry; a failed fresh search has no results worth keeping.
        videos: action.payload.append ? state.videos : [],
        totalCount: action.payload.append ? state.totalCount : 0,
        loading: false,
        loadingMore: false,
      };
    default:
      return state;
  }
}
