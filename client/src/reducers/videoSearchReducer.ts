import { VideoListItem } from '../types';

export interface VideoSearchState {
  videos: VideoListItem[];
  loading: boolean;
  error: string | null;
  query: string;
}

export enum VideoSearchActionType {
  SEARCH_START = 'SEARCH_START',
  SEARCH_SUCCESS = 'SEARCH_SUCCESS',
  SEARCH_ERROR = 'SEARCH_ERROR',
}

export type VideoSearchAction =
  | { type: VideoSearchActionType.SEARCH_START; payload: string }
  | { type: VideoSearchActionType.SEARCH_SUCCESS; payload: VideoListItem[] }
  | { type: VideoSearchActionType.SEARCH_ERROR; payload: string };

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
    case VideoSearchActionType.SEARCH_START:
      return {
        ...state,
        loading: true,
        error: null,
        query: action.payload,
      };
    case VideoSearchActionType.SEARCH_SUCCESS:
      return {
        ...state,
        videos: action.payload,
        loading: false,
      };
    case VideoSearchActionType.SEARCH_ERROR:
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

