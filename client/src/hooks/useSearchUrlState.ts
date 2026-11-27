import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { SearchState } from '../utils/searchUrlState';
import { followDefaultSort, parseSearchState, toSearchParams } from '../utils/searchUrlState';

export interface UseSearchUrlStateResult {
  /** What the URL currently says — the single source of truth for the page */
  searchState: SearchState;
  /**
   * Writes the state to the URL, replacing the current history entry. A
   * search page that pushed an entry per keystroke or per filter change
   * would trap the Back button, so the page keeps exactly one entry. A sort
   * that only stood for the old phrase's default follows the new phrase
   * (followDefaultSort), measured against the URL as it is at that moment.
   */
  setSearchState: (next: SearchState) => void;
}

export function useSearchUrlState(): UseSearchUrlStateResult {
  const [searchParams, setSearchParams] = useSearchParams();

  const searchState = useMemo(() => parseSearchState(searchParams), [searchParams]);

  const setSearchState = useCallback(
    (next: SearchState) => {
      setSearchParams((current) => toSearchParams(followDefaultSort(parseSearchState(current), next)), {
        replace: true,
      });
    },
    [setSearchParams],
  );

  return { searchState, setSearchState };
}
