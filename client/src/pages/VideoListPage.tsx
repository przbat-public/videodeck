import { useCallback } from 'react';
import { useVideoSearch } from '../hooks/useVideoSearch';
import { useCacheRefresh } from '../hooks/useCacheRefresh';
import SearchBar, { SortOption } from '../components/SearchBar';
import VideoList from '../components/VideoList';

export default function VideoListPage(): JSX.Element {
  const { videos, loading: videoLoading, query, sort, search } = useVideoSearch();
  const { loading: refreshLoading, refreshCache } = useCacheRefresh();

  const handleSearch = useCallback(async (query: string, sort: SortOption): Promise<void> => {
    await search(query, sort);
  }, [search]);

  const handleRefreshCache = useCallback(async (): Promise<void> => {
    await refreshCache();
  }, [refreshCache]);

  const handleReload = useCallback(async (): Promise<void> => {
    await search(query || '', sort);
  }, [search, query, sort]);

  return (
    <main className="app-main">
      <div className="toolbar">
        <div className="toolbar-left">
          <button
            type="button"
            onClick={handleRefreshCache}
            disabled={refreshLoading}
            className="clear-button"
            title="Refresh video cache from disk"
          >
            {refreshLoading ? 'Refreshing...' : 'Refresh Cache'}
          </button>
          <button
            type="button"
            onClick={handleReload}
            disabled={videoLoading}
            className="clear-button"
            title="Reload video list"
          >
            {videoLoading ? 'Loading...' : 'Reload'}
          </button>
        </div>
        <div className="toolbar-right">
          <span className="video-count">
            {videoLoading ? 'Loading...' : `${videos.length} video${videos.length !== 1 ? 's' : ''}`}
          </span>
        </div>
      </div>

      <SearchBar onSearch={handleSearch} />

      {videoLoading && videos.length === 0 ? (
        <div className="loading">
          <p>Loading videos...</p>
        </div>
      ) : (
        <VideoList videos={videos} searchQuery={query} />
      )}
    </main>
  );
};

