import { useReducer, useEffect, useCallback } from 'react';
import queryString from 'query-string';
import toast from 'react-hot-toast';
import { VideoListItem } from '../types';
import { SortOption } from '../components/SearchBar';
import {
  videoSearchReducer,
  initialState,
  VideoSearchActionType,
} from '../reducers/videoSearchReducer';

interface UseVideoSearchResult {
  videos: VideoListItem[];
  loading: boolean;
  error: string | null;
  query: string;
  sort: SortOption;
  search: (query?: string, sort?: SortOption) => Promise<void>;
}

export function useVideoSearch(): UseVideoSearchResult {
  const [state, dispatch] = useReducer(videoSearchReducer, initialState);

  const search = useCallback(async (query?: string, sort: SortOption = 'date-desc'): Promise<void> => {
    const trimmedQuery = query?.trim() || '';
    dispatch({ 
      type: VideoSearchActionType.SEARCH_START, 
      payload: { query: trimmedQuery, sort } 
    });
    
    try {
      const url = queryString.stringifyUrl(
        { 
          url: '/api/videos/search', 
          query: { 
            q: trimmedQuery || undefined,
            sort: sort || 'date-desc'
          } 
        },
        { skipEmptyString: true, skipNull: true }
      );
      
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error('Failed to search videos');
      }
      const data = await response.json();
      dispatch({ type: VideoSearchActionType.SEARCH_SUCCESS, payload: data.videos || [] });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'An error occurred';
      dispatch({
        type: VideoSearchActionType.SEARCH_ERROR,
        payload: errorMessage,
      });
      
      // Show error toast
      toast.error(`Failed to search videos: ${errorMessage}`);
    }
  }, []);

  useEffect(() => {
    search();
  }, [search]);

  return {
    videos: state.videos,
    loading: state.loading,
    error: state.error,
    query: state.query,
    sort: state.sort,
    search,
  };
}
