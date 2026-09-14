import { describe, it, expect } from 'vitest';
import type { SortOption } from '@shared/api';
import type { SearchState } from './searchUrlState';
import {
  DEFAULT_SEARCH_STATE,
  DEFAULT_SORT,
  SORT_OPTIONS,
  isSortOption,
  parseSearchState,
  toSearchParams,
} from './searchUrlState';

const parse = (search: string): SearchState => parseSearchState(new URLSearchParams(search));
const serialize = (state: SearchState): string => toSearchParams(state).toString();

describe('parseSearchState', () => {
  it('returns the defaults for an empty query string', () => {
    expect(parse('')).toEqual(DEFAULT_SEARCH_STATE);
    expect(DEFAULT_SEARCH_STATE).toEqual({ query: '', sort: 'date-desc', category: '' });
  });

  it('reads every field', () => {
    expect(parse('q=drone+motor&sort=views-desc&category=fpv')).toEqual({
      query: 'drone motor',
      sort: 'views-desc',
      category: 'fpv',
    });
  });

  it('decodes percent-encoded and unicode values', () => {
    expect(parse('q=%C5%9Bmig%C5%82o%20%26%20rama&category=modele%2Bsamoloty')).toEqual({
      query: 'śmigło & rama',
      sort: DEFAULT_SORT,
      category: 'modele+samoloty',
    });
  });

  it('trims surrounding whitespace from the phrase and the category', () => {
    expect(parse('q=%20%20robot%20&category=+lego+')).toEqual({
      query: 'robot',
      sort: DEFAULT_SORT,
      category: 'lego',
    });
  });

  it('treats a present-but-empty parameter like a missing one', () => {
    expect(parse('q=&sort=&category=')).toEqual(DEFAULT_SEARCH_STATE);
    expect(parse('q=%20%20')).toEqual(DEFAULT_SEARCH_STATE);
  });

  it.each(SORT_OPTIONS.map((option) => option.value))('accepts sort=%s', (sort) => {
    expect(parse(`sort=${sort}`).sort).toBe(sort);
  });

  it.each(['bogus', 'DATE-DESC', 'date_desc', 'date-desc ', '1', 'views'])(
    'falls back to the default for the unknown sort %j',
    (sort) => {
      expect(parse(`sort=${encodeURIComponent(sort)}`).sort).toBe(DEFAULT_SORT);
    }
  );

  it('uses the first value when a parameter is repeated', () => {
    expect(parse('q=first&q=second&sort=likes-asc&sort=views-desc')).toEqual({
      query: 'first',
      sort: 'likes-asc',
      category: '',
    });
  });

  it('ignores parameters it does not know', () => {
    expect(parse('page=3&utm_source=mail&q=x-ray')).toEqual({
      query: 'x-ray',
      sort: DEFAULT_SORT,
      category: '',
    });
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
    expect(serialize({ query: 'robot', sort: DEFAULT_SORT, category: '' })).toBe('q=robot');
    expect(serialize({ query: '', sort: 'likes-desc', category: '' })).toBe('sort=likes-desc');
    expect(serialize({ query: '', sort: DEFAULT_SORT, category: 'lego' })).toBe('category=lego');
  });

  it('keeps a stable key order so equal states give equal URLs', () => {
    expect(serialize({ query: 'a b', sort: 'date-asc', category: 'fpv' })).toBe(
      'q=a+b&sort=date-asc&category=fpv'
    );
  });

  it('trims the phrase and the category, dropping them when only whitespace is left', () => {
    expect(serialize({ query: '  robot  ', sort: DEFAULT_SORT, category: '  ' })).toBe('q=robot');
    expect(serialize({ query: '   ', sort: DEFAULT_SORT, category: ' fpv ' })).toBe('category=fpv');
  });

  it('encodes characters that would otherwise break the query string', () => {
    const params = toSearchParams({ query: 'a&b=c', sort: DEFAULT_SORT, category: 'x?y#z' });
    expect(params.toString()).toBe('q=a%26b%3Dc&category=x%3Fy%23z');
    expect(params.get('q')).toBe('a&b=c');
    expect(params.get('category')).toBe('x?y#z');
  });
});

describe('round trip', () => {
  const states: SearchState[] = [
    DEFAULT_SEARCH_STATE,
    { query: 'drone', sort: 'date-desc', category: '' },
    { query: 'drone motor 5"', sort: 'views-asc', category: 'fpv' },
    { query: '', sort: 'likes-desc', category: 'rc-planes' },
    { query: 'śmigło & rama', sort: 'date-asc', category: 'modele+samoloty' },
    { query: 'a=b&c', sort: 'likes-asc', category: 'x/y?z' },
  ];

  it.each(states)('parse(serialize(%j)) gives the state back', (state) => {
    expect(parseSearchState(toSearchParams(state))).toEqual(state);
  });

  it.each(SORT_OPTIONS.map((option) => option.value))(
    'survives the round trip for sort=%s',
    (sort: SortOption) => {
      const state: SearchState = { query: 'q', sort, category: 'c' };
      expect(parseSearchState(toSearchParams(state))).toEqual(state);
    }
  );

  it('normalises whitespace on the way, then stays fixed', () => {
    const once = parseSearchState(
      toSearchParams({ query: ' a ', sort: DEFAULT_SORT, category: ' c ' })
    );
    expect(once).toEqual({ query: 'a', sort: DEFAULT_SORT, category: 'c' });
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
