import type { SortOption } from '@videodeck/shared/api';
import { describe, expect, it } from 'vitest';
import type { SearchState } from './searchUrlState';
import {
  DEFAULT_SEARCH_STATE,
  followDefaultSort,
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
      state({ query: 'śmigło & rama', sort: 'relevance', category: 'modele+samoloty' }),
    );
  });

  it('trims surrounding whitespace from the phrase, sort, category and channel', () => {
    expect(parse('q=%20%20robot%20&category=+lego+&channel=+fpv+')).toEqual(
      state({ query: 'robot', sort: 'relevance', category: 'lego', channel: 'fpv' }),
    );
    expect(parse('q=robot&sort=%20date-desc%20').sort).toBe('date-desc');
  });

  it('treats a present-but-empty parameter like a missing one', () => {
    expect(parse('q=&sort=&category=&channel=')).toEqual(DEFAULT_SEARCH_STATE);
    expect(parse('q=%20%20')).toEqual(DEFAULT_SEARCH_STATE);
  });

  it.each(SORT_OPTIONS.map((option) => option.value))('accepts sort=%s', (sort) => {
    expect(parse(`sort=${sort}`).sort).toBe(sort);
  });

  it('ranks a phrase by relevance and lists everything newest first when no sort is named', () => {
    expect(parse('q=drone').sort).toBe('relevance');
    expect(parse('').sort).toBe('date-desc');
    expect(parse('q=%20%20&category=fpv').sort).toBe('date-desc');
  });

  it.each(['bogus', 'DATE-DESC', 'date_desc', 'date-desc-', '1', 'views'])(
    'falls back to the default for the unknown sort %j',
    (sort) => {
      expect(parse(`sort=${encodeURIComponent(sort)}`).sort).toBe('date-desc');
      expect(parse(`q=drone&sort=${encodeURIComponent(sort)}`).sort).toBe('relevance');
    },
  );

  it('uses the first value when a parameter is repeated', () => {
    expect(parse('q=first&q=second&sort=likes-asc&sort=views-desc')).toEqual(
      state({ query: 'first', sort: 'likes-asc' }),
    );
  });

  it('ignores parameters it does not know', () => {
    expect(parse('page=3&utm_source=mail&q=x-ray')).toEqual(state({ query: 'x-ray', sort: 'relevance' }));
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
    expect(serialize(state({ query: 'robot', sort: 'relevance' }))).toBe('q=robot');
    expect(serialize(state({ sort: 'likes-desc' }))).toBe('sort=likes-desc');
    expect(serialize(state({ category: 'lego' }))).toBe('category=lego');
    expect(serialize(state({ channel: 'Jordan B Peterson' }))).toBe('channel=Jordan+B+Peterson');
  });

  it("measures the sort against the phrase's own default", () => {
    // Newest first is a choice next to a phrase, and relevance one without it
    expect(serialize(state({ query: 'robot', sort: 'date-desc' }))).toBe('q=robot&sort=date-desc');
    expect(serialize(state({ sort: 'relevance' }))).toBe('sort=relevance');
    expect(serialize(state({ query: '   ', sort: 'date-desc' }))).toBe('');
  });

  it('keeps a stable key order so equal states give equal URLs', () => {
    expect(serialize(state({ query: 'a b', sort: 'date-asc', category: 'fpv' }))).toBe(
      'q=a+b&sort=date-asc&category=fpv',
    );
  });

  it('trims the phrase and the category, dropping them when only whitespace is left', () => {
    expect(serialize(state({ query: '  robot  ', sort: 'relevance', category: '  ' }))).toBe('q=robot');
    expect(serialize(state({ query: '   ', category: ' fpv ' }))).toBe('category=fpv');
  });

  it('encodes characters that would otherwise break the query string', () => {
    const params = toSearchParams(state({ query: 'a&b=c', sort: 'relevance', category: 'x?y#z' }));
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
    // With a phrase and without one, so neither default swallows a choice
    for (const query of ['q', '']) {
      const item: SearchState = state({ query, sort, category: 'c' });
      expect(parseSearchState(toSearchParams(item))).toEqual(item);
    }
  });

  it('normalises whitespace on the way, then stays fixed', () => {
    const once = parseSearchState(toSearchParams(state({ query: ' a ', category: ' c ' })));
    expect(once).toEqual(state({ query: 'a', category: 'c' }));
    expect(parseSearchState(toSearchParams(once))).toEqual(once);
  });
});

describe('followDefaultSort', () => {
  it("moves a sort that only stood for the old phrase's default to the new phrase's", () => {
    // A phrase typed on the start page ranks by relevance...
    expect(followDefaultSort(state({}), state({ query: 'dron' }))).toEqual(state({ query: 'dron', sort: 'relevance' }));
    // ...and clearing it brings the newest videos back first
    expect(
      followDefaultSort(state({ query: 'dron', sort: 'relevance' }), state({ query: '', sort: 'relevance' })),
    ).toEqual(state({}));
  });

  it('keeps a sort the user picked when the phrase changes', () => {
    expect(followDefaultSort(state({ sort: 'views-desc' }), state({ query: 'dron', sort: 'views-desc' }))).toEqual(
      state({ query: 'dron', sort: 'views-desc' }),
    );
    expect(
      followDefaultSort(state({ query: 'dron', sort: 'date-desc' }), state({ query: 'rower', sort: 'date-desc' })),
    ).toEqual(state({ query: 'rower', sort: 'date-desc' }));
  });

  it('leaves a change that keeps the phrase alone, surrounding whitespace aside', () => {
    const previous = state({ query: 'dron', sort: 'relevance' });

    expect(followDefaultSort(previous, state({ query: 'dron', sort: 'date-desc' }))).toEqual(
      state({ query: 'dron', sort: 'date-desc' }),
    );
    expect(followDefaultSort(previous, state({ query: ' dron ', sort: 'relevance', category: 'fpv' }))).toEqual(
      state({ query: ' dron ', sort: 'relevance', category: 'fpv' }),
    );
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
