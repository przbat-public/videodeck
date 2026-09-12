import { useState, useEffect, useMemo } from 'react';

import type { SortOption } from '@shared/api';
import { debounce } from '../utils/debounce';

interface SearchBarProps {
  onSearch: (query: string, sort: SortOption, category: string) => void;
  /** Categories offered by the server; empty hides the filter */
  categories?: string[];
}

const MIN_SEARCH_LENGTH = 3;
const DEBOUNCE_DELAY = 300;

export default function SearchBar({ onSearch, categories = [] }: SearchBarProps) {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortOption>('date-desc');
  const [category, setCategory] = useState('');

  const debouncedSearch = useMemo(
    () =>
      debounce((searchQuery: string, searchSort: SortOption, searchCategory: string) => {
        onSearch(searchQuery, searchSort, searchCategory);
      }, DEBOUNCE_DELAY),
    [onSearch]
  );

  useEffect(() => {
    const trimmedQuery = query.trim();

    if (trimmedQuery.length >= MIN_SEARCH_LENGTH) {
      debouncedSearch(trimmedQuery, sort, category);
    } else if (trimmedQuery.length === 0) {
      debouncedSearch('', sort, category);
    }

    return () => {
      debouncedSearch.cancel();
    };
  }, [query, sort, category, debouncedSearch]);

  const handleSortChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newSort = e.target.value as SortOption;
    setSort(newSort);
  };

  const handleClear = () => {
    setQuery('');
  };

  return (
    <div className="search-bar">
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search videos by description..."
        className="search-input"
      />
      {categories.length > 0 && (
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="category-select"
          aria-label="Category"
        >
          <option value="">All categories</option>
          {categories.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      )}
      <select value={sort} onChange={handleSortChange} className="sort-select">
        <option value="date-desc">Newest first</option>
        <option value="date-asc">Oldest first</option>
        <option value="views-desc">Most views first</option>
        <option value="views-asc">Least views first</option>
        <option value="likes-desc">Most likes first</option>
        <option value="likes-asc">Least likes first</option>
      </select>
      {query && (
        <button type="button" onClick={handleClear} className="clear-button">
          Clear
        </button>
      )}
    </div>
  );
}
