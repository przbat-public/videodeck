import type { JSX } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useRegisterMenuSections } from '../components/appMenuRegistry';
import SearchBar from '../components/SearchBar';
import { Button } from '../components/ui/Button';
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
  const { videos, loading: videoLoading, hasMore, search, loadMore } = useVideoSearch();
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

  // The list page owns these actions, the top bar menu shows them: reload,
  // the two reindex actions and the only-missing switch.
  useRegisterMenuSections([
    {
      key: 'results',
      label: t('menu.results'),
      items: [
        {
          key: 'reload',
          label: t('menu.reloadResults'),
          disabled: videoLoading,
          title: t('reindex.reloadTitle'),
          onSelect: () => void handleReload(),
        },
      ],
    },
    {
      key: 'indexes',
      label: t('menu.indexes'),
      items: [
        {
          key: 'refresh',
          label: refreshLoading ? t('reindex.refreshing') : t('reindex.start'),
          disabled: refreshLoading,
          title: t('reindex.startTitle'),
          onSelect: () => void handleRefreshCache(),
        },
        {
          key: 'onlyMissing',
          label: t('reindex.onlyMissing'),
          title: t('reindex.onlyMissingTitle'),
          checkbox: { checked: onlyMissing, onCheckedChange: setOnlyMissing },
        },
        {
          key: 'recreate',
          label: recreateIndicesLoading ? t('reindex.recreating') : t('reindex.recreate'),
          disabled: recreateIndicesLoading,
          title: t('reindex.recreateTitle'),
          onSelect: () => void handleRecreateIndices(),
        },
      ],
    },
  ]);

  return (
    <main className="app-main">
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
