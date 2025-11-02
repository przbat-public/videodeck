import { VideoListItem } from '../types';

export interface VideoSearchState {
  videos: VideoListItem[];
  loading: boolean;
  error: string | null;
  query: string;
}

export type VideoSearchAction =
  | { type: 'SEARCH_START'; payload: string }
  | { type: 'SEARCH_SUCCESS'; payload: VideoListItem[] }
  | { type: 'SEARCH_ERROR'; payload: string };

export const initialState: VideoSearchState = {
  videos: [],
  loading: false,
  error: null,
  query: '',
};

export function videoSearchReducer(
  state: VideoSearchState,
  action: VideoSearchAction
): VideoSearchState {
  switch (action.type) {
    case 'SEARCH_START':
      return {
        ...state,
        loading: true,
        error: null,
        query: action.payload,
      };
    case 'SEARCH_SUCCESS':
      return {
        ...state,
        videos: action.payload,
        loading: false,
      };
    case 'SEARCH_ERROR':
      return {
        ...state,
        error: action.payload,
        videos: [],
        loading: false,
      };
    default:
      return state;
  }
}

