import type { VideoListItem } from '@videodeck/shared/api';
import { SEARCH_DEFAULT_PAGE_SIZE } from '@videodeck/shared/schemas';

export interface VideoSearchState {
  videos: VideoListItem[];
  /** Rows the server has handed over for this search, released ones included */
  loadedCount: number;
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

/**
 * Rows the results window keeps. "Load more" appends a page at a time, so
 * without a bound the array, and the cards it renders, grow for as long as the
 * user scrolls; two pages of scroll-back stay in memory instead. `loadedCount`
 * remembers where the result set really stands, so the next request still asks
 * for the rows after everything loaded rather than the rows on screen.
 */
export const MAX_RETAINED_VIDEOS = 2 * SEARCH_DEFAULT_PAGE_SIZE;

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
  loadedCount: 0,
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
    case VideoSearchActionType.SEARCH_SUCCESS: {
      // `append` accumulates a "load more" page onto the current results
      const videos = action.payload.append ? [...state.videos, ...action.payload.videos] : action.payload.videos;
      return {
        ...state,
        // The window keeps the rows loaded last: the ones around the position
        // the user scrolled to. Older rows are released, not remembered.
        videos: videos.slice(-MAX_RETAINED_VIDEOS),
        loadedCount: action.payload.append ? state.loadedCount + action.payload.videos.length : videos.length,
        totalCount: action.payload.totalCount,
        loading: false,
        loadingMore: false,
      };
    }
    case VideoSearchActionType.SEARCH_ERROR:
      return {
        ...state,
        error: action.payload.message,
        // A failed "load more" keeps the pages already on screen so the user
        // can retry; a failed fresh search has no results worth keeping.
        videos: action.payload.append ? state.videos : [],
        loadedCount: action.payload.append ? state.loadedCount : 0,
        totalCount: action.payload.append ? state.totalCount : 0,
        loading: false,
        loadingMore: false,
      };
    default:
      return state;
  }
}
