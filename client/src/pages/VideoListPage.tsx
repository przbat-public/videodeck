import { useCallback } from 'react';
import { useVideoSearch } from '../hooks/useVideoSearch';
import { useCacheRefresh } from '../hooks/useCacheRefresh';
import { useCategories } from '../hooks/useCategories';
import { useRecreateIndices } from '../hooks/useRecreateIndices';
import type { SortOption } from '@shared/api';
import SearchBar from '../components/SearchBar';
import VideoList from '../components/VideoList';

export default function VideoListPage(): JSX.Element {
  const {
    videos,
    totalCount,
    loading: videoLoading,
    query,
    sort,
    category,
    search,
  } = useVideoSearch();
  const { loading: refreshLoading, refreshCache } = useCacheRefresh();
  const { categories } = useCategories();
  const { loading: recreateIndicesLoading, recreateIndices } = useRecreateIndices();

  const handleSearch = useCallback(
    async (query: string, sort: SortOption, category: string): Promise<void> => {
      await search(query, sort, category);
    },
    [search]
  );

  const handleRefreshCache = useCallback(async (): Promise<void> => {
    // refreshCache resolves when the server-side reindex is over
    await refreshCache();
    await search(query || '', sort, category);
  }, [refreshCache, search, query, sort, category]);

  const handleReload = useCallback(async (): Promise<void> => {
    await search(query || '', sort, category);
  }, [search, query, sort, category]);

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

      <SearchBar onSearch={handleSearch} categories={categories} />

      {videoLoading && videos.length === 0 ? (
        <div className="loading">
          <p>Loading videos...</p>
        </div>
      ) : (
        <VideoList videos={videos} searchQuery={query} />
      )}
    </main>
  );
}
