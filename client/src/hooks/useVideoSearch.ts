import { useReducer, useCallback, useRef } from 'react';
import toast from 'react-hot-toast';
import type { VideoListItem } from '@shared/api';
import { SearchResponseSchema } from '@shared/schemas';
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
  // The request in flight; a new one aborts it so typing fast does not leave
  // a trail of doomed fetches behind
  const abortRef = useRef<AbortController | null>(null);
  // Guards loadMore against double clicks (the disabled state lands a tick
  // too late to prevent two pages with the same offset)
  const inFlightRef = useRef(false);

  const runSearch = useCallback(
    async (searchState: SearchState, offset: number, append: boolean): Promise<void> => {
      const requestId = ++latestRequestRef.current;
      const isCurrent = () => requestId === latestRequestRef.current;

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      inFlightRef.current = true;

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

        const response = await fetch(`/api/videos/search?${params.toString()}`, {
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error('Failed to search videos');
        }
        const data = SearchResponseSchema.parse(await response.json());
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
        // Superseded by a newer request — its own lifecycle reports
        if (controller.signal.aborted || !isCurrent()) {
          return;
        }
        const errorMessage = err instanceof Error ? err.message : 'An error occurred';
        dispatch({
          type: VideoSearchActionType.SEARCH_ERROR,
          payload: errorMessage,
        });

        // One toast slot: rapid typing must not stack a toast per keystroke
        toast.error(`Nie udało się wyszukać filmów: ${errorMessage}`, {
          id: 'video-search-error',
        });
      } finally {
        if (isCurrent()) {
          inFlightRef.current = false;
        }
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
    if (inFlightRef.current) {
      return;
    }
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
