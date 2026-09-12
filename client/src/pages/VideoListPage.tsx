import { useCallback, useEffect } from 'react';
import { useVideoSearch } from '../hooks/useVideoSearch';
import { useCacheRefresh } from '../hooks/useCacheRefresh';
import { useCategories } from '../hooks/useCategories';
import { useRecreateIndices } from '../hooks/useRecreateIndices';
import { useSearchUrlState } from '../hooks/useSearchUrlState';
import SearchBar from '../components/SearchBar';
import VideoList from '../components/VideoList';

export default function VideoListPage(): JSX.Element {
  const { searchState, setSearchState } = useSearchUrlState();
  const { query, sort, category } = searchState;
  const { videos, totalCount, loading: videoLoading, search } = useVideoSearch();
  const { loading: refreshLoading, refreshCache } = useCacheRefresh();
  const { categories } = useCategories();
  const { loading: recreateIndicesLoading, recreateIndices } = useRecreateIndices();

  // The URL drives the results: a deep link, a reload and a change made in
  // the search bar all arrive here the same way.
  useEffect(() => {
    void search({ query, sort, category });
  }, [search, query, sort, category]);

  const handleRefreshCache = useCallback(async (): Promise<void> => {
    // refreshCache resolves when the server-side reindex is over
    await refreshCache();
    await search({ query, sort, category });
  }, [refreshCache, search, query, sort, category]);

  const handleReload = useCallback(async (): Promise<void> => {
    await search({ query, sort, category });
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

      <SearchBar
        query={query}
        sort={sort}
        category={category}
        categories={categories}
        onChange={setSearchState}
      />

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
