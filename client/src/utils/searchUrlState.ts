import type { SortOption } from '@videodeck/shared/api';
import { defaultSortFor } from '@videodeck/shared/search';

/**
 * The search state of /videos lives in the URL (`?q=&sort=&category=`), so a
 * link can be bookmarked or shared and a reload lands on the same results.
 * This module is the only place that knows how the two shapes map onto each
 * other; both directions are pure so they can be tested exhaustively.
 *
 * The default sort depends on the phrase (relevance with one, newest first
 * without, see defaultSortFor), and both directions measure against that.
 */

export interface SearchState {
  /** Trimmed search phrase; '' means "everything" */
  query: string;
  sort: SortOption;
  /** Trimmed category; '' means "all categories" */
  category: string;
  /** Exact channel filter; '' means "all channels" */
  channel: string;
}

export const DEFAULT_SEARCH_STATE: SearchState = {
  query: '',
  sort: defaultSortFor(''),
  category: '',
  channel: '',
};

export type SortLabelKey =
  | 'sortOption.relevance'
  | 'sortOption.dateDesc'
  | 'sortOption.dateAsc'
  | 'sortOption.viewsDesc'
  | 'sortOption.viewsAsc'
  | 'sortOption.likesDesc'
  | 'sortOption.likesAsc';

/** Every sort option with its i18n key, in the order the select shows them */
export const SORT_OPTIONS: ReadonlyArray<{ value: SortOption; labelKey: SortLabelKey }> = [
  { value: 'relevance', labelKey: 'sortOption.relevance' },
  { value: 'date-desc', labelKey: 'sortOption.dateDesc' },
  { value: 'date-asc', labelKey: 'sortOption.dateAsc' },
  { value: 'views-desc', labelKey: 'sortOption.viewsDesc' },
  { value: 'views-asc', labelKey: 'sortOption.viewsAsc' },
  { value: 'likes-desc', labelKey: 'sortOption.likesDesc' },
  { value: 'likes-asc', labelKey: 'sortOption.likesAsc' },
];

export const isSortOption = (value: string): value is SortOption =>
  SORT_OPTIONS.some((option) => option.value === value);

/**
 * URL → state. Values are trimmed, a missing or unknown `sort` falls back to
 * the phrase's default and anything else in the URL is ignored. Never throws:
 * a hand-typed URL must not break the page.
 */
export function parseSearchState(params: URLSearchParams): SearchState {
  const sort = (params.get('sort') ?? '').trim();
  const query = (params.get('q') ?? '').trim();
  return {
    query,
    sort: isSortOption(sort) ? sort : defaultSortFor(query),
    category: (params.get('category') ?? '').trim(),
    channel: (params.get('channel') ?? '').trim(),
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
  if (state.sort !== defaultSortFor(query)) {
    params.set('sort', state.sort);
  }
  const category = state.category.trim();
  if (category.length > 0) {
    params.set('category', category);
  }
  const channel = state.channel.trim();
  if (channel.length > 0) {
    params.set('channel', channel);
  }
  return params;
}

/**
 * The state a committed change should land on. The form commits a new phrase
 * with the sort it showed, and a sort that only stood for the old phrase's
 * default would otherwise outlive it: a phrase typed on the start page kept
 * newest first, and a cleared phrase kept relevance. Such a sort follows the
 * phrase to its own default; a sort the user picked stays as it is.
 */
export function followDefaultSort(previous: SearchState, next: SearchState): SearchState {
  const query = next.query.trim();
  if (query === previous.query.trim() || next.sort !== defaultSortFor(previous.query)) {
    return next;
  }
  return { ...next, sort: defaultSortFor(query) };
}
