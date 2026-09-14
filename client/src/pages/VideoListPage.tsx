import { useCallback, useEffect, useState } from 'react';
import type { JSX } from 'react';
import { useVideoSearch } from '../hooks/useVideoSearch';
import { useCacheRefresh } from '../hooks/useCacheRefresh';
import { useCategories } from '../hooks/useCategories';
import { useChannelNames } from '../hooks/useChannelNames';
import { useRecreateIndices } from '../hooks/useRecreateIndices';
import { useSearchUrlState } from '../hooks/useSearchUrlState';
import SearchBar from '../components/SearchBar';
import VideoList from '../components/VideoList';
import { Button } from '../components/ui/Button';
import { Checkbox } from '../components/ui/Checkbox';
import { Loading } from '../components/ui/Loading';

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
  const { query, sort, category, channel, dateFrom, dateTo } = searchState;
  const { videos, totalCount, loading: videoLoading, hasMore, search, loadMore } = useVideoSearch();
  const { loading: refreshLoading, refreshCache } = useCacheRefresh();
  const { categories } = useCategories();
  const { channels } = useChannelNames();
  const { loading: recreateIndicesLoading, recreateIndices } = useRecreateIndices();
  const [onlyMissing, setOnlyMissing] = useState(false);

  // The URL drives the results: a deep link, a reload and a change made in
  // the search bar all arrive here the same way.
  useEffect(() => {
    void search({ query, sort, category, channel, dateFrom, dateTo });
  }, [search, query, sort, category, channel, dateFrom, dateTo]);

  const handleRefreshCache = useCallback(async (): Promise<void> => {
    // refreshCache resolves when the server-side reindex is over
    await refreshCache(onlyMissing ? { onlyMissing: true } : undefined);
    await search({ query, sort, category, channel, dateFrom, dateTo });
  }, [refreshCache, onlyMissing, search, query, sort, category, channel, dateFrom, dateTo]);

  const handleReload = useCallback(async (): Promise<void> => {
    await search({ query, sort, category, channel, dateFrom, dateTo });
  }, [search, query, sort, category, channel, dateFrom, dateTo]);

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
          <Button
            onClick={handleRecreateIndices}
            disabled={recreateIndicesLoading}
            title="Odbuduj wszystkie indeksy Elasticsearch"
          >
            {recreateIndicesLoading ? 'Odbudowywanie...' : 'Odbuduj indeksy'}
          </Button>
          <Button
            onClick={handleRefreshCache}
            disabled={refreshLoading}
            title="Odśwież indeks filmów z dysku"
          >
            {refreshLoading ? 'Odświeżanie...' : 'Odśwież indeks'}
          </Button>
          <Checkbox
            checked={onlyMissing}
            onChange={setOnlyMissing}
            label="tylko brakujące (użyj istniejącego indeksu)"
            title="Pomiń foldery, które mają już indeks w Elasticsearch (np. cache poprzednio podpiętego dysku)"
          />
          <Button onClick={handleReload} disabled={videoLoading} title="Odśwież listę filmów">
            {videoLoading ? 'Ładowanie...' : 'Odśwież'}
          </Button>
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
        channel={channel}
        dateFrom={dateFrom}
        dateTo={dateTo}
        categories={categories}
        channels={channels}
        onChange={setSearchState}
      />

      {videoLoading && videos.length === 0 ? (
        <Loading message="Ładowanie filmów..." />
      ) : (
        <>
          <VideoList videos={videos} searchQuery={query} />
          {hasMore && (
            <div className="load-more">
              <Button onClick={handleLoadMore} disabled={videoLoading}>
                {videoLoading ? 'Ładowanie...' : 'Pokaż więcej'}
              </Button>
            </div>
          )}
        </>
      )}
    </main>
  );
}
