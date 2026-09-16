import type { SortOption } from '@videodeck/shared/api';
import { describe, expect, it } from 'vitest';
import type { SearchState } from './searchUrlState';
import {
  DEFAULT_SEARCH_STATE,
  DEFAULT_SORT,
  isSortOption,
  parseSearchState,
  SORT_OPTIONS,
  toSearchParams,
} from './searchUrlState';

const parse = (search: string): SearchState => parseSearchState(new URLSearchParams(search));
const serialize = (state: SearchState): string => toSearchParams(state).toString();

/** A SearchState with the filter fields at their defaults */
const state = (patch: Partial<SearchState>): SearchState => ({
  ...DEFAULT_SEARCH_STATE,
  ...patch,
});

describe('parseSearchState', () => {
  it('returns the defaults for an empty query string', () => {
    expect(parse('')).toEqual(DEFAULT_SEARCH_STATE);
    expect(DEFAULT_SEARCH_STATE).toEqual({
      query: '',
      sort: 'date-desc',
      category: '',
      channel: '',
    });
  });

  it('reads every field', () => {
    expect(parse('q=drone+motor&sort=views-desc&category=fpv')).toEqual(
      state({ query: 'drone motor', sort: 'views-desc', category: 'fpv' }),
    );
    expect(parse('channel=Jordan+B+Peterson')).toEqual(state({ channel: 'Jordan B Peterson' }));
  });

  it('ignores the legacy date parameters, like any unknown parameter', () => {
    expect(parse('dateFrom=2024-01-05&dateTo=2025-12-31')).toEqual(state({}));
    expect(parse('dateFrom=20240105&dateTo=abc')).toEqual(state({}));
  });

  it('decodes percent-encoded and unicode values', () => {
    expect(parse('q=%C5%9Bmig%C5%82o%20%26%20rama&category=modele%2Bsamoloty')).toEqual(
      state({ query: 'śmigło & rama', category: 'modele+samoloty' }),
    );
  });

  it('trims surrounding whitespace from the phrase, category and channel', () => {
    expect(parse('q=%20%20robot%20&category=+lego+&channel=+fpv+')).toEqual(
      state({ query: 'robot', category: 'lego', channel: 'fpv' }),
    );
  });

  it('treats a present-but-empty parameter like a missing one', () => {
    expect(parse('q=&sort=&category=&channel=')).toEqual(DEFAULT_SEARCH_STATE);
    expect(parse('q=%20%20')).toEqual(DEFAULT_SEARCH_STATE);
  });

  it.each(SORT_OPTIONS.map((option) => option.value))('accepts sort=%s', (sort) => {
    expect(parse(`sort=${sort}`).sort).toBe(sort);
  });

  it.each(['bogus', 'DATE-DESC', 'date_desc', 'date-desc ', '1', 'views'])(
    'falls back to the default for the unknown sort %j',
    (sort) => {
      expect(parse(`sort=${encodeURIComponent(sort)}`).sort).toBe(DEFAULT_SORT);
    },
  );

  it('uses the first value when a parameter is repeated', () => {
    expect(parse('q=first&q=second&sort=likes-asc&sort=views-desc')).toEqual(
      state({ query: 'first', sort: 'likes-asc' }),
    );
  });

  it('ignores parameters it does not know', () => {
    expect(parse('page=3&utm_source=mail&q=x-ray')).toEqual(state({ query: 'x-ray' }));
  });

  it('is case-sensitive about parameter names', () => {
    expect(parse('Q=robot&Sort=views-desc&CATEGORY=lego')).toEqual(DEFAULT_SEARCH_STATE);
  });
});

describe('toSearchParams', () => {
  it('serialises the default state to nothing at all', () => {
    expect(serialize(DEFAULT_SEARCH_STATE)).toBe('');
  });

  it('writes only the fields that differ from the defaults', () => {
    expect(serialize(state({ query: 'robot' }))).toBe('q=robot');
    expect(serialize(state({ sort: 'likes-desc' }))).toBe('sort=likes-desc');
    expect(serialize(state({ category: 'lego' }))).toBe('category=lego');
    expect(serialize(state({ channel: 'Jordan B Peterson' }))).toBe('channel=Jordan+B+Peterson');
  });

  it('keeps a stable key order so equal states give equal URLs', () => {
    expect(serialize(state({ query: 'a b', sort: 'date-asc', category: 'fpv' }))).toBe(
      'q=a+b&sort=date-asc&category=fpv',
    );
  });

  it('trims the phrase and the category, dropping them when only whitespace is left', () => {
    expect(serialize(state({ query: '  robot  ', category: '  ' }))).toBe('q=robot');
    expect(serialize(state({ query: '   ', category: ' fpv ' }))).toBe('category=fpv');
  });

  it('encodes characters that would otherwise break the query string', () => {
    const params = toSearchParams(state({ query: 'a&b=c', category: 'x?y#z' }));
    expect(params.toString()).toBe('q=a%26b%3Dc&category=x%3Fy%23z');
    expect(params.get('q')).toBe('a&b=c');
    expect(params.get('category')).toBe('x?y#z');
  });
});

describe('round trip', () => {
  const states: SearchState[] = [
    DEFAULT_SEARCH_STATE,
    state({ query: 'drone' }),
    state({ query: 'drone motor 5"', sort: 'views-asc', category: 'fpv' }),
    state({ sort: 'likes-desc', category: 'rc-planes' }),
    state({ query: 'śmigło & rama', sort: 'date-asc', category: 'modele+samoloty' }),
    state({ query: 'a=b&c', sort: 'likes-asc', category: 'x/y?z' }),
    state({ channel: 'Jordan B Peterson' }),
  ];

  it.each(states)('parse(serialize(%j)) gives the state back', (item) => {
    expect(parseSearchState(toSearchParams(item))).toEqual(item);
  });

  it.each(SORT_OPTIONS.map((option) => option.value))('survives the round trip for sort=%s', (sort: SortOption) => {
    const item: SearchState = state({ query: 'q', sort, category: 'c' });
    expect(parseSearchState(toSearchParams(item))).toEqual(item);
  });

  it('normalises whitespace on the way, then stays fixed', () => {
    const once = parseSearchState(toSearchParams(state({ query: ' a ', category: ' c ' })));
    expect(once).toEqual(state({ query: 'a', category: 'c' }));
    expect(parseSearchState(toSearchParams(once))).toEqual(once);
  });
});

describe('isSortOption', () => {
  it('knows every option the select offers and nothing else', () => {
    expect(SORT_OPTIONS.length).toBe(7);
    for (const option of SORT_OPTIONS) {
      expect(isSortOption(option.value)).toBe(true);
    }
    expect(isSortOption('')).toBe(false);
    expect(isSortOption('date')).toBe(false);
    expect(isSortOption('Date-Desc')).toBe(false);
  });
});
