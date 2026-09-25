import type { JSX } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useRegisterMenuSections } from '../components/appMenuRegistry';
import { LoadMore } from '../components/LoadMore';
import SearchBar from '../components/SearchBar';
import { ErrorMessage } from '../components/ui/ErrorMessage';
import { Loading } from '../components/ui/Loading';
import VideoList from '../components/VideoList';
import { useCacheRefresh } from '../hooks/useCacheRefresh';
import { useCategories } from '../hooks/useCategories';
import { useChannelNames } from '../hooks/useChannelNames';
import { usePageFocus } from '../hooks/usePageFocus';
import { useRecreateIndices } from '../hooks/useRecreateIndices';
import { useSearchUrlState } from '../hooks/useSearchUrlState';
import { useVideoSearch } from '../hooks/useVideoSearch';
import { useElasticsearchState } from '../utils/elasticsearchStatus';

export default function VideoListPage(): JSX.Element {
  const { searchState, setSearchState } = useSearchUrlState();
  const { query, sort, category, channel } = searchState;
  const { videos, loading: videoLoading, error: videoError, hasMore, search, loadMore } = useVideoSearch();
  const { loading: refreshLoading, refreshCache } = useCacheRefresh();
  const { categories } = useCategories();
  const { channels } = useChannelNames();
  const { loading: recreateIndicesLoading, recreateIndices } = useRecreateIndices();
  const elasticsearchDown = useElasticsearchState() === 'down';
  const [onlyMissing, setOnlyMissing] = useState(false);
  const { t } = useTranslation();
  const mainRef = usePageFocus<HTMLElement>();

  // The URL drives the results: a deep link, a reload and a change made in
  // the search bar all arrive here the same way.
  useEffect(() => {
    void search({ query, sort, category, channel });
  }, [search, query, sort, category, channel]);

  const handleRefreshCache = useCallback(async (): Promise<void> => {
    // refreshCache resolves when the server-side reindex is over
    await refreshCache(onlyMissing ? { onlyMissing: true } : undefined);
    await search({ query, sort, category, channel });
  }, [refreshCache, onlyMissing, search, query, sort, category, channel]);

  const handleReload = useCallback(async (): Promise<void> => {
    await search({ query, sort, category, channel });
  }, [search, query, sort, category, channel]);

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
          // Both index actions need the cluster; the banner above the page
          // says why they are off
          disabled: refreshLoading || elasticsearchDown,
          title: elasticsearchDown ? t('reindex.elasticsearchDownTitle') : t('reindex.startTitle'),
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
          disabled: recreateIndicesLoading || elasticsearchDown,
          title: elasticsearchDown ? t('reindex.elasticsearchDownTitle') : t('reindex.recreateTitle'),
          onSelect: () => void handleRecreateIndices(),
        },
      ],
    },
  ]);

  // A failed search must not dress itself up as "no results": the error is the
  // message, and a failed "load more" keeps the pages already on screen.
  const showEmptyState = !videoError;

  return (
    <main className="app-main" ref={mainRef} tabIndex={-1} aria-busy={videoLoading}>
      <SearchBar
        query={query}
        sort={sort}
        category={category}
        channel={channel}
        categories={categories}
        channels={channels}
        onChange={setSearchState}
      />

      {videoLoading && videos.length === 0 ? (
        <Loading message={t('search.loading')} />
      ) : (
        <>
          {videoError && <ErrorMessage>{t('app.error', { message: videoError })}</ErrorMessage>}
          {videoLoading && videos.length > 0 && (
            // Announced, not just decorative: the cards on screen still answer
            // the previous query while the new one is in flight.
            <p className="search-refreshing" role="status">
              {t('search.loading')}
            </p>
          )}
          {(videos.length > 0 || showEmptyState) && <VideoList videos={videos} searchQuery={query} />}
          {hasMore && <LoadMore loading={videoLoading} failed={videoError !== null} onLoadMore={handleLoadMore} />}
        </>
      )}
    </main>
  );
}
