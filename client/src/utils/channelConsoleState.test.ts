import { describe, expect, it } from 'vitest';
import {
  CHANNEL_FILTERS,
  CHANNEL_SORTS,
  DEFAULT_CHANNEL_CONSOLE_STATE,
  parseChannelConsoleState,
  toChannelConsoleParams,
} from './channelConsoleState';

describe('parseChannelConsoleState', () => {
  it('reads the query, the filter, the sort and the expanded folder', () => {
    const state = parseChannelConsoleState(
      new URLSearchParams('q=fpv&filter=attention&sort=missing&folder=%2Fvideos%2Fkanal-a'),
    );

    expect(state).toEqual({
      query: 'fpv',
      filter: 'attention',
      sort: 'missing',
      folder: '/videos/kanal-a',
    });
  });

  it('falls back to the defaults for an empty or hand-typed URL', () => {
    expect(parseChannelConsoleState(new URLSearchParams())).toEqual(DEFAULT_CHANNEL_CONSOLE_STATE);
    expect(parseChannelConsoleState(new URLSearchParams('filter=nope&sort=whatever&q=%20%20'))).toEqual(
      DEFAULT_CHANNEL_CONSOLE_STATE,
    );
  });
});

describe('toChannelConsoleParams', () => {
  it('drops the defaults so the plain URL stays plain', () => {
    expect(toChannelConsoleParams(DEFAULT_CHANNEL_CONSOLE_STATE).toString()).toBe('');
  });

  it('writes every non-default value', () => {
    const params = toChannelConsoleParams({
      query: ' fpv ',
      filter: 'failed',
      sort: 'updated',
      folder: '/videos/kanal-a',
    });

    expect(params.get('q')).toBe('fpv');
    expect(params.get('filter')).toBe('failed');
    expect(params.get('sort')).toBe('updated');
    expect(params.get('folder')).toBe('/videos/kanal-a');
  });

  it('round-trips through the URL', () => {
    const state = { query: 'lego', filter: 'queue' as const, sort: 'name' as const, folder: '' };
    expect(parseChannelConsoleState(toChannelConsoleParams(state))).toEqual(state);
  });
});

describe('filter and sort options', () => {
  it('offers every filter with an i18n label key', () => {
    expect(CHANNEL_FILTERS.map((option) => option.value)).toEqual(['all', 'attention', 'queue', 'failed']);
    expect(CHANNEL_FILTERS.every((option) => option.labelKey.startsWith('channelConsole.filter.'))).toBe(true);
  });

  it('offers every sort with an i18n label key', () => {
    expect(CHANNEL_SORTS.map((option) => option.value)).toEqual(['name', 'attention', 'updated', 'missing']);
    expect(CHANNEL_SORTS.every((option) => option.labelKey.startsWith('channelConsole.sort.'))).toBe(true);
  });
});
