import type { SortOption } from '@shared/api';

/**
 * The search state of /videos lives in the URL (`?q=&sort=&category=`), so a
 * link can be bookmarked or shared and a reload lands on the same results.
 * This module is the only place that knows how the two shapes map onto each
 * other; both directions are pure so they can be tested exhaustively.
 */

export interface SearchState {
  /** Trimmed search phrase; '' means "everything" */
  query: string;
  sort: SortOption;
  /** Trimmed category; '' means "all categories" */
  category: string;
}

export const DEFAULT_SORT: SortOption = 'date-desc';

export const DEFAULT_SEARCH_STATE: SearchState = {
  query: '',
  sort: DEFAULT_SORT,
  category: '',
};

/** Every sort option with its label, in the order the select shows them */
export const SORT_OPTIONS: ReadonlyArray<{ value: SortOption; label: string }> = [
  { value: 'date-desc', label: 'Newest first' },
  { value: 'date-asc', label: 'Oldest first' },
  { value: 'views-desc', label: 'Most views first' },
  { value: 'views-asc', label: 'Least views first' },
  { value: 'likes-desc', label: 'Most likes first' },
  { value: 'likes-asc', label: 'Least likes first' },
];

export const isSortOption = (value: string): value is SortOption =>
  SORT_OPTIONS.some((option) => option.value === value);

/**
 * URL → state. Values are trimmed, an unknown `sort` falls back to the
 * default and anything else in the URL is ignored. Never throws: a
 * hand-typed URL must not break the page.
 */
export function parseSearchState(params: URLSearchParams): SearchState {
  const sort = (params.get('sort') ?? '').trim();
  return {
    query: (params.get('q') ?? '').trim(),
    sort: isSortOption(sort) ? sort : DEFAULT_SORT,
    category: (params.get('category') ?? '').trim(),
  };
}

/**
 * State → URL. Defaults are left out so the plain `/videos` URL stays plain
 * and two ways of saying "everything" do not produce two different URLs.
 */
export function toSearchParams(state: SearchState): URLSearchParams {
  const params = new URLSearchParams();
  const query = state.query.trim();
  if (query.length > 0) {
    params.set('q', query);
  }
  if (state.sort !== DEFAULT_SORT) {
    params.set('sort', state.sort);
  }
  const category = state.category.trim();
  if (category.length > 0) {
    params.set('category', category);
  }
  return params;
}
