import { useCallback, useEffect, useState } from 'react';
import type { JSX } from 'react';
import { useVideoSearch } from '../hooks/useVideoSearch';
import { useCacheRefresh } from '../hooks/useCacheRefresh';
import { useCategories } from '../hooks/useCategories';
import { useRecreateIndices } from '../hooks/useRecreateIndices';
import { useSearchUrlState } from '../hooks/useSearchUrlState';
import SearchBar from '../components/SearchBar';
import VideoList from '../components/VideoList';

/** Polish plural: 1 film, 2 filmy, 5 filmów */
function pluralVideos(count: number): string {
  if (count === 1) {
    return 'film';
  }
  const lastDigit = count % 10;
  const lastTwo = count % 100;
  if (lastDigit >= 2 && lastDigit <= 4 && !(lastTwo >= 12 && lastTwo <= 14)) {
    return 'filmy';
  }
  return 'filmów';
}

export default function VideoListPage(): JSX.Element {
  const { searchState, setSearchState } = useSearchUrlState();
  const { query, sort, category } = searchState;
  const { videos, totalCount, loading: videoLoading, hasMore, search, loadMore } = useVideoSearch();
  const { loading: refreshLoading, refreshCache } = useCacheRefresh();
  const { categories } = useCategories();
  const { loading: recreateIndicesLoading, recreateIndices } = useRecreateIndices();
  const [onlyMissing, setOnlyMissing] = useState(false);

  // The URL drives the results: a deep link, a reload and a change made in
  // the search bar all arrive here the same way.
  useEffect(() => {
    void search({ query, sort, category });
  }, [search, query, sort, category]);

  const handleRefreshCache = useCallback(async (): Promise<void> => {
    // refreshCache resolves when the server-side reindex is over
    await refreshCache(onlyMissing ? { onlyMissing: true } : undefined);
    await search({ query, sort, category });
  }, [refreshCache, onlyMissing, search, query, sort, category]);

  const handleReload = useCallback(async (): Promise<void> => {
    await search({ query, sort, category });
  }, [search, query, sort, category]);

  const handleRecreateIndices = useCallback(async (): Promise<void> => {
    await recreateIndices();
  }, [recreateIndices]);

  const handleLoadMore = useCallback(() => {
    void loadMore();
  }, [loadMore]);

  return (
    <main className="app-main">
      <div className="toolbar">
        <div className="toolbar-left">
          <button
            type="button"
            onClick={handleRecreateIndices}
            disabled={recreateIndicesLoading}
            className="clear-button"
            title="Odbuduj wszystkie indeksy Elasticsearch"
          >
            {recreateIndicesLoading ? 'Odbudowywanie...' : 'Odbuduj indeksy'}
          </button>
          <button
            type="button"
            onClick={handleRefreshCache}
            disabled={refreshLoading}
            className="clear-button"
            title="Odśwież indeks filmów z dysku"
          >
            {refreshLoading ? 'Odświeżanie...' : 'Odśwież indeks'}
          </button>
          <label
            className="toolbar-checkbox"
            title="Pomiń foldery, które mają już indeks w Elasticsearch (np. cache poprzednio podpiętego dysku)"
          >
            <input
              type="checkbox"
              checked={onlyMissing}
              onChange={(event) => setOnlyMissing(event.target.checked)}
            />
            tylko brakujące (użyj istniejącego indeksu)
          </label>
          <button
            type="button"
            onClick={handleReload}
            disabled={videoLoading}
            className="clear-button"
            title="Odśwież listę filmów"
          >
            {videoLoading ? 'Ładowanie...' : 'Odśwież'}
          </button>
        </div>
        <div className="toolbar-right">
          <span className="video-count">
            {videoLoading
              ? 'Ładowanie...'
              : `${videos.length} ${pluralVideos(videos.length)}${totalCount > 0 ? ` / ${totalCount} łącznie` : ''}`}
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
          <p>Ładowanie filmów...</p>
        </div>
      ) : (
        <>
          <VideoList videos={videos} searchQuery={query} />
          {hasMore && (
            <div className="load-more">
              <button
                type="button"
                onClick={handleLoadMore}
                disabled={videoLoading}
                className="clear-button"
              >
                {videoLoading ? 'Ładowanie...' : 'Pokaż więcej'}
              </button>
            </div>
          )}
        </>
      )}
    </main>
  );
}
