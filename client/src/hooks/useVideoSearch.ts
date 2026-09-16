import type { VideoListItem } from '@videodeck/shared/api';
import { SEARCH_DEFAULT_PAGE_SIZE, SearchResponseSchema } from '@videodeck/shared/schemas';
import type { Dispatch } from 'react';
import { useCallback, useReducer, useRef } from 'react';
import toast from 'react-hot-toast';
import i18n from '../i18n';
import {
  initialState,
  type VideoSearchAction,
  VideoSearchActionType,
  videoSearchReducer,
} from '../reducers/videoSearchReducer';
import type { SearchState } from '../utils/searchUrlState';
import { DEFAULT_SEARCH_STATE, toSearchParams } from '../utils/searchUrlState';

/** How many videos one request pulls; matches the server's default page size */
const PAGE_SIZE = SEARCH_DEFAULT_PAGE_SIZE;

/** The search state as query params plus paging; the URL layer owns the serialization */
function buildSearchParams(searchState: SearchState, offset: number): URLSearchParams {
  const params = toSearchParams(searchState);
  params.set('offset', String(offset));
  params.set('limit', String(PAGE_SIZE));
  return params;
}

/** Reports the failure unless the request was superseded or aborted */
function reportSearchError(
  err: unknown,
  wasAborted: boolean,
  isCurrent: () => boolean,
  dispatch: Dispatch<VideoSearchAction>,
): void {
  if (wasAborted || !isCurrent()) {
    return;
  }
  const errorMessage = err instanceof Error ? err.message : i18n.t('errors.occurred');
  dispatch({
    type: VideoSearchActionType.SEARCH_ERROR,
    payload: errorMessage,
  });

  // One toast slot: rapid typing must not stack a toast per keystroke
  toast.error(i18n.t('toast.searchFailed', { message: errorMessage }), {
    id: 'video-search-error',
  });
}

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
  const searchStateRef = useRef<SearchState>(DEFAULT_SEARCH_STATE);
  // The request in flight; a new one aborts it so typing fast does not leave
  // a trail of doomed fetches behind
  const abortRef = useRef<AbortController | null>(null);
  // Guards loadMore against double clicks (the disabled state lands a tick
  // too late to prevent two pages with the same offset)
  const inFlightRef = useRef(false);

  const runSearch = useCallback(async (searchState: SearchState, offset: number, append: boolean): Promise<void> => {
    const requestId = ++latestRequestRef.current;
    const isCurrent = () => requestId === latestRequestRef.current;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    inFlightRef.current = true;

    dispatch({ type: VideoSearchActionType.SEARCH_START });

    try {
      const params = buildSearchParams(searchState, offset);
      const response = await fetch(`/api/videos/search?${params.toString()}`, {
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(i18n.t('errors.search'));
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
      reportSearchError(err, controller.signal.aborted, isCurrent, dispatch);
    } finally {
      if (isCurrent()) {
        inFlightRef.current = false;
      }
    }
  }, []);

  const search = useCallback(
    async (searchState: SearchState): Promise<void> => {
      searchStateRef.current = searchState;
      await runSearch(searchState, 0, false);
    },
    [runSearch],
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
