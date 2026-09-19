import type { ChannelFilter, ChannelSort } from './channelTable';

/**
 * The console's view state lives in the URL (`?q=&filter=&sort=&folder=`), so a
 * link can point at one channel, a reload keeps the filter and Back leaves the
 * page instead of undoing a chip. Both directions are pure.
 */

export interface ChannelConsoleState {
  /** Trimmed text filter; '' means "every channel" */
  query: string;
  filter: ChannelFilter;
  sort: ChannelSort;
  /** Folder path of the expanded row; '' means "nothing expanded" */
  folder: string;
}

export const DEFAULT_CHANNEL_CONSOLE_STATE: ChannelConsoleState = {
  query: '',
  filter: 'all',
  sort: 'name',
  folder: '',
};

export interface ChannelFilterOption {
  value: ChannelFilter;
  labelKey:
    | 'channelConsole.filter.all'
    | 'channelConsole.filter.attention'
    | 'channelConsole.filter.queue'
    | 'channelConsole.filter.failed';
}

/** The filter chips, in the order they are shown */
export const CHANNEL_FILTERS: readonly ChannelFilterOption[] = [
  { value: 'all', labelKey: 'channelConsole.filter.all' },
  { value: 'attention', labelKey: 'channelConsole.filter.attention' },
  { value: 'queue', labelKey: 'channelConsole.filter.queue' },
  { value: 'failed', labelKey: 'channelConsole.filter.failed' },
];

export interface ChannelSortOption {
  value: ChannelSort;
  labelKey:
    | 'channelConsole.sort.name'
    | 'channelConsole.sort.attention'
    | 'channelConsole.sort.updated'
    | 'channelConsole.sort.missing';
}

/** The sort choices, in the order they are shown */
export const CHANNEL_SORTS: readonly ChannelSortOption[] = [
  { value: 'name', labelKey: 'channelConsole.sort.name' },
  { value: 'attention', labelKey: 'channelConsole.sort.attention' },
  { value: 'updated', labelKey: 'channelConsole.sort.updated' },
  { value: 'missing', labelKey: 'channelConsole.sort.missing' },
];

const isChannelFilter = (value: string): value is ChannelFilter =>
  CHANNEL_FILTERS.some((option) => option.value === value);

const isChannelSort = (value: string): value is ChannelSort => CHANNEL_SORTS.some((option) => option.value === value);

/** URL → state. An unknown chip or sort falls back to the default. */
export function parseChannelConsoleState(params: URLSearchParams): ChannelConsoleState {
  const filter = (params.get('filter') ?? '').trim();
  const sort = (params.get('sort') ?? '').trim();
  return {
    query: (params.get('q') ?? '').trim(),
    filter: isChannelFilter(filter) ? filter : DEFAULT_CHANNEL_CONSOLE_STATE.filter,
    sort: isChannelSort(sort) ? sort : DEFAULT_CHANNEL_CONSOLE_STATE.sort,
    folder: (params.get('folder') ?? '').trim(),
  };
}

/** State → URL. Defaults stay out so two ways of saying "everything" match. */
export function toChannelConsoleParams(state: ChannelConsoleState): URLSearchParams {
  const params = new URLSearchParams();
  const query = state.query.trim();
  if (query.length > 0) {
    params.set('q', query);
  }
  if (state.filter !== DEFAULT_CHANNEL_CONSOLE_STATE.filter) {
    params.set('filter', state.filter);
  }
  if (state.sort !== DEFAULT_CHANNEL_CONSOLE_STATE.sort) {
    params.set('sort', state.sort);
  }
  if (state.folder.length > 0) {
    params.set('folder', state.folder);
  }
  return params;
}
