import type { SortOption, VideoListItem } from '@shared/api';

export interface VideoSearchState {
  videos: VideoListItem[];
  totalCount: number;
  loading: boolean;
  error: string | null;
  query: string;
  sort: SortOption;
  /** '' means every category */
  category: string;
}

export enum VideoSearchActionType {
  SEARCH_START = 'SEARCH_START',
  SEARCH_SUCCESS = 'SEARCH_SUCCESS',
  SEARCH_ERROR = 'SEARCH_ERROR',
}

export type VideoSearchAction =
  | {
      type: VideoSearchActionType.SEARCH_START;
      payload: { query: string; sort: SortOption; category: string };
    }
  | {
      type: VideoSearchActionType.SEARCH_SUCCESS;
      payload: { videos: VideoListItem[]; totalCount: number };
    }
  | { type: VideoSearchActionType.SEARCH_ERROR; payload: string };

export const initialState: VideoSearchState = {
  videos: [],
  totalCount: 0,
  loading: false,
  error: null,
  query: '',
  sort: 'date-desc',
  category: '',
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
        query: action.payload.query,
        sort: action.payload.sort,
        category: action.payload.category,
      };
    case VideoSearchActionType.SEARCH_SUCCESS:
      return {
        ...state,
        videos: action.payload.videos,
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
