import { useState, useEffect, useMemo } from 'react';
import { debounce } from 'lodash';

export type SortOption = 
  | 'date-desc'
  | 'date-asc'
  | 'views-desc'
  | 'views-asc'
  | 'likes-desc'
  | 'likes-asc';

interface SearchBarProps {
  onSearch: (query: string, sort: SortOption) => void;
  loading?: boolean;
}

const MIN_SEARCH_LENGTH = 3;
const DEBOUNCE_DELAY = 300;

export default function SearchBar({ onSearch }: SearchBarProps) {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortOption>('date-desc');

  const debouncedSearch = useMemo(
    () => debounce((searchQuery: string, searchSort: SortOption) => {
      onSearch(searchQuery, searchSort);
    }, DEBOUNCE_DELAY),
    [onSearch]
  );

  useEffect(() => {
    const trimmedQuery = query.trim();
    
    if (trimmedQuery.length >= MIN_SEARCH_LENGTH) {
      debouncedSearch(trimmedQuery, sort);
    } else if (trimmedQuery.length === 0) {
      debouncedSearch('', sort);
    }

    return () => {
      debouncedSearch.cancel();
    };
  }, [query, sort, debouncedSearch]);

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
      <select
        value={sort}
        onChange={handleSortChange}
        className="sort-select"
      >
        <option value="date-desc">Newest first</option>
        <option value="date-asc">Oldest first</option>
        <option value="views-desc">Most views first</option>
        <option value="views-asc">Least views first</option>
        <option value="likes-desc">Most likes first</option>
        <option value="likes-asc">Least likes first</option>
      </select>
      {query && (
        <button
          type="button"
          onClick={handleClear}
          className="clear-button"
        >
          Clear
        </button>
      )}
    </div>
  );
}
