import { useEffect, useState } from 'react';

import type { SortOption } from '@shared/api';
import type { SearchState } from '../utils/searchUrlState';
import { SORT_OPTIONS } from '../utils/searchUrlState';

interface SearchBarProps {
  /** The committed search — what the URL and the results currently reflect */
  query: string;
  sort: SortOption;
  category: string;
  /** Categories offered by the server; the filter hides when there is nothing to pick */
  categories?: string[];
  onChange: (next: SearchState) => void;
}

const MIN_SEARCH_LENGTH = 3;
const DEBOUNCE_DELAY = 300;

/** A phrase worth searching for: nothing at all, or enough to be selective */
const isSearchable = (trimmed: string): boolean =>
  trimmed.length === 0 || trimmed.length >= MIN_SEARCH_LENGTH;

export default function SearchBar({
  query,
  sort,
  category,
  categories = [],
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
      onChange({ query: trimmed, sort, category });
    }, DEBOUNCE_DELAY);
    return () => window.clearTimeout(handle);
  }, [text, query, sort, category, onChange]);

  /**
   * Selects commit right away. A phrase still too short to search stays in
   * the input, and the commit keeps the query the results already show.
   */
  const commitWith = (patch: Partial<SearchState>) => {
    const trimmed = text.trim();
    onChange({ query: isSearchable(trimmed) ? trimmed : query, sort, category, ...patch });
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
        <select
          value={category}
          onChange={(e) => commitWith({ category: e.target.value })}
          className="category-select"
          aria-label="Kategoria"
        >
          <option value="">Wszystkie kategorie</option>
          {categoryOptions.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      )}
      <select
        value={sort}
        onChange={(e) => commitWith({ sort: e.target.value as SortOption })}
        className="sort-select"
        aria-label="Sort"
      >
        {SORT_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {text && (
        <button type="button" onClick={handleClear} className="clear-button">
          Clear
        </button>
      )}
    </div>
  );
}
