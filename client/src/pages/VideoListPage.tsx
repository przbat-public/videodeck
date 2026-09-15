import type { JSX } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import SearchBar from '../components/SearchBar';
import { Button } from '../components/ui/Button';
import { Checkbox } from '../components/ui/Checkbox';
import { Loading } from '../components/ui/Loading';
import VideoList from '../components/VideoList';
import { useCacheRefresh } from '../hooks/useCacheRefresh';
import { useCategories } from '../hooks/useCategories';
import { useChannelNames } from '../hooks/useChannelNames';
import { useRecreateIndices } from '../hooks/useRecreateIndices';
import { useSearchUrlState } from '../hooks/useSearchUrlState';
import { useVideoSearch } from '../hooks/useVideoSearch';

export default function VideoListPage(): JSX.Element {
  const { searchState, setSearchState } = useSearchUrlState();
  const { query, sort, category, channel, dateFrom, dateTo } = searchState;
  const { videos, totalCount, loading: videoLoading, hasMore, search, loadMore } = useVideoSearch();
  const { loading: refreshLoading, refreshCache } = useCacheRefresh();
  const { categories } = useCategories();
  const { channels } = useChannelNames();
  const { loading: recreateIndicesLoading, recreateIndices } = useRecreateIndices();
  const [onlyMissing, setOnlyMissing] = useState(false);
  const { t } = useTranslation();

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
          <Button onClick={handleRecreateIndices} disabled={recreateIndicesLoading} title={t('reindex.recreateTitle')}>
            {recreateIndicesLoading ? t('reindex.recreating') : t('reindex.recreate')}
          </Button>
          <Button onClick={handleRefreshCache} disabled={refreshLoading} title={t('reindex.startTitle')}>
            {refreshLoading ? t('reindex.refreshing') : t('reindex.start')}
          </Button>
          <Checkbox
            checked={onlyMissing}
            onChange={setOnlyMissing}
            label={t('reindex.onlyMissing')}
            title={t('reindex.onlyMissingTitle')}
          />
          <Button onClick={handleReload} disabled={videoLoading} title={t('reindex.reloadTitle')}>
            {videoLoading ? t('app.loading') : t('reindex.reload')}
          </Button>
        </div>
        <div className="toolbar-right">
          <span className="video-count">
            {videoLoading
              ? t('app.loading')
              : `${t('videoCount', { count: videos.length })}${totalCount > 0 ? ` / ${t('search.total', { count: totalCount })}` : ''}`}
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
        <Loading message={t('search.loading')} />
      ) : (
        <>
          <VideoList videos={videos} searchQuery={query} />
          {hasMore && (
            <div className="load-more">
              <Button onClick={handleLoadMore} disabled={videoLoading}>
                {videoLoading ? t('app.loading') : t('search.loadMore')}
              </Button>
            </div>
          )}
        </>
      )}
    </main>
  );
}
