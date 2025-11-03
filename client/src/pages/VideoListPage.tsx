import { useCallback } from 'react';
import { useVideoSearch } from '../hooks/useVideoSearch';
import SearchBar, { SortOption } from '../components/SearchBar';
import VideoList from '../components/VideoList';

export default function VideoListPage(): JSX.Element {
  const { videos, loading, error, query, search } = useVideoSearch();

  const handleSearch = useCallback(async (query: string, sort: SortOption): Promise<void> => {
    await search(query, sort);
  }, [search]);

  return (
    <main className="app-main">
      <SearchBar onSearch={handleSearch} />

      {error && (
        <div className="error-message">
          <p>Error: {error}</p>
        </div>
      )}

      {loading && videos.length === 0 ? (
        <div className="loading">
          <p>Loading videos...</p>
        </div>
      ) : (
        <VideoList videos={videos} searchQuery={query} />
      )}
    </main>
  );
};

