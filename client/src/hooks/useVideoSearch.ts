import { useReducer, useEffect, useCallback } from 'react';
import toast from 'react-hot-toast';
import type { SearchResponse, SortOption, VideoListItem } from '@shared/api';
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
  query: string;
  sort: SortOption;
  category: string;
  search: (query?: string, sort?: SortOption, category?: string) => Promise<void>;
}

export function useVideoSearch(): UseVideoSearchResult {
  const [state, dispatch] = useReducer(videoSearchReducer, initialState);

  const search = useCallback(
    async (query?: string, sort: SortOption = 'date-desc', category = ''): Promise<void> => {
      const trimmedQuery = query?.trim() || '';
      const trimmedCategory = category.trim();
      dispatch({
        type: VideoSearchActionType.SEARCH_START,
        payload: { query: trimmedQuery, sort, category: trimmedCategory },
      });

      try {
        const params = new URLSearchParams();
        if (trimmedQuery) {
          params.set('q', trimmedQuery);
        }
        params.set('sort', sort || 'date-desc');
        if (trimmedCategory) {
          params.set('category', trimmedCategory);
        }

        const response = await fetch(`/api/videos/search?${params.toString()}`);
        if (!response.ok) {
          throw new Error('Failed to search videos');
        }
        const data: SearchResponse = await response.json();
        dispatch({
          type: VideoSearchActionType.SEARCH_SUCCESS,
          payload: {
            videos: data.videos || [],
            totalCount: data.totalCount || 0,
          },
        });
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'An error occurred';
        dispatch({
          type: VideoSearchActionType.SEARCH_ERROR,
          payload: errorMessage,
        });

        // Show error toast
        toast.error(`Failed to search videos: ${errorMessage}`);
      }
    },
    []
  );

  useEffect(() => {
    search();
  }, [search]);

  return {
    videos: state.videos,
    totalCount: state.totalCount,
    loading: state.loading,
    error: state.error,
    query: state.query,
    sort: state.sort,
    category: state.category,
    search,
  };
}
