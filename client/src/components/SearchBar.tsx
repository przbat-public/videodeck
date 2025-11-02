import { useState, FormEvent } from 'react';

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

export default function SearchBar({ onSearch, loading }: SearchBarProps) {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortOption>('date-desc');

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    onSearch(query, sort);
  };

  const handleSortChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newSort = e.target.value as SortOption;
    setSort(newSort);
    onSearch(query, newSort);
  };

  const handleClear = () => {
    setQuery('');
    onSearch('', sort);
  };

  return (
    <form onSubmit={handleSubmit} className="search-bar">
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search videos by description..."
        disabled={loading}
        className="search-input"
      />
      <select
        value={sort}
        onChange={handleSortChange}
        disabled={loading}
        className="sort-select"
      >
        <option value="date-desc">Newest first</option>
        <option value="date-asc">Oldest first</option>
        <option value="views-desc">Most views first</option>
        <option value="views-asc">Least views first</option>
        <option value="likes-desc">Most likes first</option>
        <option value="likes-asc">Least likes first</option>
      </select>
      <button type="submit" disabled={loading} className="search-button">
        {loading ? 'Searching...' : 'Search'}
      </button>
      {query && (
        <button
          type="button"
          onClick={handleClear}
          disabled={loading}
          className="clear-button"
        >
          Clear
        </button>
      )}
    </form>
  );
}
