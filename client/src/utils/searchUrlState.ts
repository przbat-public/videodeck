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
  /** Exact channel filter; '' means "all channels" */
  channel: string;
  /** Upload-date range as yyyyMMdd; '' means unbounded */
  dateFrom: string;
  dateTo: string;
}

export const DEFAULT_SORT: SortOption = 'date-desc';

export const DEFAULT_SEARCH_STATE: SearchState = {
  query: '',
  sort: DEFAULT_SORT,
  category: '',
  channel: '',
  dateFrom: '',
  dateTo: '',
};

/** Every sort option with its label, in the order the select shows them */
export const SORT_OPTIONS: ReadonlyArray<{ value: SortOption; label: string }> = [
  { value: 'relevance', label: 'Trafność' },
  { value: 'date-desc', label: 'Najnowsze' },
  { value: 'date-asc', label: 'Najstarsze' },
  { value: 'views-desc', label: 'Najwięcej wyświetleń' },
  { value: 'views-asc', label: 'Najmniej wyświetleń' },
  { value: 'likes-desc', label: 'Najwięcej polubień' },
  { value: 'likes-asc', label: 'Najmniej polubień' },
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
    channel: (params.get('channel') ?? '').trim(),
    dateFrom: toDateDigits(params.get('dateFrom')),
    dateTo: toDateDigits(params.get('dateTo')),
  };
}

/** `2024-01-05` → `20240105`; anything malformed is ignored */
function toDateDigits(value: string | null): string {
  const digits = (value ?? '').replace(/\D/g, '');
  return digits.length === 8 ? digits : '';
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
  const channel = state.channel.trim();
  if (channel.length > 0) {
    params.set('channel', channel);
  }
  if (/^\d{8}$/.test(state.dateFrom)) {
    params.set('dateFrom', toDisplayDate(state.dateFrom));
  }
  if (/^\d{8}$/.test(state.dateTo)) {
    params.set('dateTo', toDisplayDate(state.dateTo));
  }
  return params;
}

/** `20240105` → `2024-01-05` (the value a date input displays) */
function toDisplayDate(digits: string): string {
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
}
