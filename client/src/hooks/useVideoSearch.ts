import { useReducer, useCallback, useRef } from 'react';
import toast from 'react-hot-toast';
import type { SearchResponse, VideoListItem } from '@shared/api';
import type { SearchState } from '../utils/searchUrlState';
import {
  videoSearchReducer,
  initialState,
  VideoSearchActionType,
} from '../reducers/videoSearchReducer';

interface UseVideoSearchResult {
  videos: VideoListItem[];
  totalCount: number;
  loading: boolean;
  error: string | null;
  /** Runs a search; the caller decides when (the page runs one per URL change) */
  search: (state: SearchState) => Promise<void>;
}

export function useVideoSearch(): UseVideoSearchResult {
  const [state, dispatch] = useReducer(videoSearchReducer, initialState);
  // Searches can overlap when the URL changes twice in a row. Only the
  // newest one may touch the results, or a slow early response would
  // overwrite the answer to the question the URL is actually asking.
  const latestRequestRef = useRef(0);

  const search = useCallback(async ({ query, sort, category }: SearchState): Promise<void> => {
    const requestId = ++latestRequestRef.current;
    const isCurrent = () => requestId === latestRequestRef.current;
    const trimmedQuery = query.trim();
    const trimmedCategory = category.trim();
    dispatch({ type: VideoSearchActionType.SEARCH_START });

    try {
      const params = new URLSearchParams();
      if (trimmedQuery) {
        params.set('q', trimmedQuery);
      }
      params.set('sort', sort);
      if (trimmedCategory) {
        params.set('category', trimmedCategory);
      }

      const response = await fetch(`/api/videos/search?${params.toString()}`);
      if (!response.ok) {
        throw new Error('Failed to search videos');
      }
      const data: SearchResponse = await response.json();
      if (!isCurrent()) {
        return;
      }
      dispatch({
        type: VideoSearchActionType.SEARCH_SUCCESS,
        payload: {
          videos: data.videos || [],
          totalCount: data.totalCount || 0,
        },
      });
    } catch (err) {
      if (!isCurrent()) {
        return;
      }
      const errorMessage = err instanceof Error ? err.message : 'An error occurred';
      dispatch({
        type: VideoSearchActionType.SEARCH_ERROR,
        payload: errorMessage,
      });

      toast.error(`Failed to search videos: ${errorMessage}`);
    }
  }, []);

  return {
    videos: state.videos,
    totalCount: state.totalCount,
    loading: state.loading,
    error: state.error,
    search,
  };
}
