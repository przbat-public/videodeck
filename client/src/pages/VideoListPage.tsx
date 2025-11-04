import { useCallback } from 'react';
import { useVideoSearch } from '../hooks/useVideoSearch';
import { useCacheRefresh } from '../hooks/useCacheRefresh';
import { useRecreateIndices } from '../hooks/useRecreateIndices';
import SearchBar, { SortOption } from '../components/SearchBar';
import VideoList from '../components/VideoList';

export default function VideoListPage(): JSX.Element {
  const { videos, totalCount, loading: videoLoading, query, sort, search } = useVideoSearch();
  const { loading: refreshLoading, refreshCache } = useCacheRefresh();
  const { loading: recreateIndicesLoading, recreateIndices } = useRecreateIndices();

  const handleSearch = useCallback(async (query: string, sort: SortOption): Promise<void> => {
    await search(query, sort);
  }, [search]);

  const handleRefreshCache = useCallback(async (): Promise<void> => {
    await refreshCache();
  }, [refreshCache]);

  const handleReload = useCallback(async (): Promise<void> => {
    await search(query || '', sort);
  }, [search, query, sort]);

  const handleRecreateIndices = useCallback(async (): Promise<void> => {
    await recreateIndices();
  }, [recreateIndices]);

  return (
    <main className="app-main">
      <div className="toolbar">
        <div className="toolbar-left">
          <button
            type="button"
            onClick={handleRecreateIndices}
            disabled={recreateIndicesLoading}
            className="clear-button"
            title="Recreate all Elasticsearch indices"
          >
            {recreateIndicesLoading ? 'Recreating...' : 'Recreate Indices'}
          </button>
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
            {videoLoading 
              ? 'Loading...' 
              : `${videos.length} video${videos.length !== 1 ? 's' : ''}${totalCount > 0 ? ` / ${totalCount} total` : ''}`}
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

