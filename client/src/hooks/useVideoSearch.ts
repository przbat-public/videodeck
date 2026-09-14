import { useReducer, useCallback, useRef } from 'react';
import toast from 'react-hot-toast';
import type { SearchResponse, VideoListItem } from '@shared/api';
import type { SearchState } from '../utils/searchUrlState';
import {
  videoSearchReducer,
  initialState,
  VideoSearchActionType,
} from '../reducers/videoSearchReducer';

/** How many videos one request pulls; matches the server's default page size */
const PAGE_SIZE = 100;

interface UseVideoSearchResult {
  videos: VideoListItem[];
  totalCount: number;
  loading: boolean;
  error: string | null;
  /** True while the server knows about more videos than are loaded */
  hasMore: boolean;
  /** Runs a search from scratch; the caller decides when (the page runs one per URL change) */
  search: (state: SearchState) => Promise<void>;
  /** Fetches the next page and appends it to the current results */
  loadMore: () => Promise<void>;
}

export function useVideoSearch(): UseVideoSearchResult {
  const [state, dispatch] = useReducer(videoSearchReducer, initialState);
  // Searches can overlap when the URL changes twice in a row. Only the
  // newest one may touch the results, or a slow early response would
  // overwrite the answer to the question the URL is actually asking.
  const latestRequestRef = useRef(0);
  // The search the next loadMore call continues (offset = videos.length)
  const searchStateRef = useRef<SearchState>({ query: '', sort: 'date-desc', category: '' });

  const runSearch = useCallback(
    async (searchState: SearchState, offset: number, append: boolean): Promise<void> => {
      const requestId = ++latestRequestRef.current;
      const isCurrent = () => requestId === latestRequestRef.current;
      const trimmedQuery = searchState.query.trim();
      const trimmedCategory = searchState.category.trim();
      dispatch({ type: VideoSearchActionType.SEARCH_START });

      try {
        const params = new URLSearchParams();
        if (trimmedQuery) {
          params.set('q', trimmedQuery);
        }
        params.set('sort', searchState.sort);
        if (trimmedCategory) {
          params.set('category', trimmedCategory);
        }
        params.set('offset', String(offset));
        params.set('limit', String(PAGE_SIZE));

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
            ...(append ? { append } : {}),
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
    },
    []
  );

  const search = useCallback(
    async (searchState: SearchState): Promise<void> => {
      searchStateRef.current = searchState;
      await runSearch(searchState, 0, false);
    },
    [runSearch]
  );

  const loadMore = useCallback(async (): Promise<void> => {
    await runSearch(searchStateRef.current, state.videos.length, true);
  }, [runSearch, state.videos.length]);

  return {
    videos: state.videos,
    totalCount: state.totalCount,
    loading: state.loading,
    error: state.error,
    hasMore: state.videos.length < state.totalCount,
    search,
    loadMore,
  };
}
