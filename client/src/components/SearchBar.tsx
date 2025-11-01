import { useState, FormEvent } from 'react';

interface SearchBarProps {
  onSearch: (query: string) => void;
  loading?: boolean;
}

export default function SearchBar({ onSearch, loading }: SearchBarProps) {
  const [query, setQuery] = useState('');

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    onSearch(query);
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
      <button type="submit" disabled={loading} className="search-button">
        {loading ? 'Searching...' : 'Search'}
      </button>
      {query && (
        <button
          type="button"
          onClick={() => {
            setQuery('');
            onSearch('');
          }}
          disabled={loading}
          className="clear-button"
        >
          Clear
        </button>
      )}
    </form>
  );
}
