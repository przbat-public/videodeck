import { useVideoSearch } from '../hooks/useVideoSearch';
import SearchBar from '../components/SearchBar';
import VideoList from '../components/VideoList';

export default function VideoListPage() {
  const { videos, loading, error, search } = useVideoSearch();

  const handleSearch = async (query: string) => {
    await search(query);
  };

  return (
    <main className="app-main">
      <SearchBar onSearch={handleSearch} loading={loading} />

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
        <VideoList videos={videos} />
      )}
    </main>
  );
}

