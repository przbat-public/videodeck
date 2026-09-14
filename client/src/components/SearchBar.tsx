import { useEffect, useState } from 'react';

import type { SortOption } from '@shared/api';
import type { SearchState } from '../utils/searchUrlState';
import { SORT_OPTIONS } from '../utils/searchUrlState';
import { Button } from './ui/Button';
import { Select } from './ui/Select';

interface SearchBarProps {
  /** The committed search — what the URL and the results currently reflect */
  query: string;
  sort: SortOption;
  category: string;
  channel: string;
  dateFrom: string;
  dateTo: string;
  /** Categories offered by the server; the filter hides when there is nothing to pick */
  categories?: string[];
  /** Channel names offered by the server (datalist suggestions) */
  channels?: string[];
  onChange: (next: SearchState) => void;
}

const MIN_SEARCH_LENGTH = 3;
const DEBOUNCE_DELAY = 300;

/** A phrase worth searching for: nothing at all, or enough to be selective */
const isSearchable = (trimmed: string): boolean =>
  trimmed.length === 0 || trimmed.length >= MIN_SEARCH_LENGTH;

/** `20240105` ↔ `2024-01-05` (what a date input displays) */
const toDisplayDate = (digits: string): string =>
  digits.length === 8 ? `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}` : '';
const toDateDigits = (value: string): string => {
  const digits = value.replace(/\D/g, '');
  return digits.length === 8 ? digits : '';
};

export default function SearchBar({
  query,
  sort,
  category,
  channel,
  dateFrom,
  dateTo,
  categories = [],
  channels = [],
  onChange,
}: SearchBarProps) {
  // The input is typed into faster than we want to search, so it keeps its
  // own text and commits it to `onChange` after a pause. `query` is the
  // committed value; the two only differ while the user is typing.
  const [text, setText] = useState(query);
  const [seenQuery, setSeenQuery] = useState(query);
  if (query !== seenQuery) {
    // The committed query changed outside the input (deep link, history
    // navigation): show it. Surrounding whitespace is the one difference
    // we tolerate, otherwise our own commit would eat a space being typed.
    setSeenQuery(query);
    if (query !== text.trim()) {
      setText(query);
    }
  }

  useEffect(() => {
    const trimmed = text.trim();
    if (trimmed === query || !isSearchable(trimmed)) {
      return undefined;
    }
    const handle = window.setTimeout(() => {
      onChange({ query: trimmed, sort, category, channel, dateFrom, dateTo });
    }, DEBOUNCE_DELAY);
    return () => window.clearTimeout(handle);
  }, [text, query, sort, category, channel, dateFrom, dateTo, onChange]);

  /**
   * Selects commit right away. A phrase still too short to search stays in
   * the input, and the commit keeps the query the results already show.
   */
  const commitWith = (patch: Partial<SearchState>) => {
    const trimmed = text.trim();
    onChange({
      query: isSearchable(trimmed) ? trimmed : query,
      sort,
      category,
      channel,
      dateFrom,
      dateTo,
      ...patch,
    });
  };

  const handleClear = () => {
    setText('');
    commitWith({ query: '' });
  };

  const categoryOptions =
    category.length > 0 && !categories.includes(category)
      ? [...categories, category] // a URL may name a category the list does not (yet) know
      : categories;

  return (
    <div className="search-bar">
      <input
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Szukaj filmów po opisie..."
        className="search-input"
      />
      {categoryOptions.length > 0 && (
        <Select
          value={category}
          onChange={(value) => commitWith({ category: value })}
          className="category-select"
          aria-label="Kategoria"
          items={[
            { value: '', label: 'Wszystkie kategorie' },
            ...categoryOptions.map((name) => ({ value: name, label: name })),
          ]}
        />
      )}
      <Select
        value={sort}
        onChange={(value) => commitWith({ sort: value as SortOption })}
        className="sort-select"
        aria-label="Sort"
        items={SORT_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
      />
      {channels.length > 0 && (
        <>
          <input
            type="text"
            list="channel-suggestions"
            value={channel}
            onChange={(e) => commitWith({ channel: e.target.value })}
            placeholder="Kanał..."
            className="channel-input"
            aria-label="Kanał"
          />
          <datalist id="channel-suggestions">
            {channels.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </>
      )}
      <input
        type="date"
        value={toDisplayDate(dateFrom)}
        onChange={(e) => commitWith({ dateFrom: toDateDigits(e.target.value) })}
        className="date-filter"
        aria-label="Od daty"
      />
      <input
        type="date"
        value={toDisplayDate(dateTo)}
        onChange={(e) => commitWith({ dateTo: toDateDigits(e.target.value) })}
        className="date-filter"
        aria-label="Do daty"
      />
      {text && (
        <Button onClick={handleClear} size="small">
          Clear
        </Button>
      )}
    </div>
  );
}
