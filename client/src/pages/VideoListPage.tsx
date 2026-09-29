import type { JSX } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router-dom';
import { MAIN_CONTENT_ID } from '../components/AppLayout';
import { useRegisterMenuSections } from '../components/appMenuRegistry';
import { LoadMore } from '../components/LoadMore';
import SearchBar from '../components/SearchBar';
import { ErrorMessage } from '../components/ui/ErrorMessage';
import { Loading } from '../components/ui/Loading';
import VideoList from '../components/VideoList';
import { useCacheRefresh } from '../hooks/useCacheRefresh';
import { useCategories } from '../hooks/useCategories';
import { useChannelNames } from '../hooks/useChannelNames';
import { useListScrollRestoration } from '../hooks/useListScrollRestoration';
import { usePageFocus } from '../hooks/usePageFocus';
import { useRecreateIndices } from '../hooks/useRecreateIndices';
import { useSearchUrlState } from '../hooks/useSearchUrlState';
import { useVideoSearch } from '../hooks/useVideoSearch';
import { useElasticsearchState } from '../utils/elasticsearchStatus';
import { subscribeReindexFinished } from '../utils/reindexStore';

/**
 * The two names this route gives the search on screen: the tab title and the
 * level one heading. Both follow the phrase in the URL and fall back to the
 * app, so neither can drift from the other or from the results below.
 */
function useResultsLabels(query: string): { title: string; heading: string } {
  const { t } = useTranslation();
  if (query) {
    return {
      title: t('pageTitle.resultsQuery', { query }),
      heading: t('search.headingWithQuery', { query }),
    };
  }
  return { title: t('pageTitle.results'), heading: t('search.heading') };
}

export default function VideoListPage(): JSX.Element {
  const { searchState, setSearchState } = useSearchUrlState();
  const { query, sort, category, channel } = searchState;
  const { title, heading } = useResultsLabels(query);
  const {
    videos,
    loading: videoLoading,
    loadingMore: videoLoadingMore,
    error: videoError,
    hasMore,
    droppedCount,
    search,
    loadMore,
  } = useVideoSearch();
  // Whatever is in flight makes the results busy; the page itself stays usable
  const resultsBusy = videoLoading || videoLoadingMore;
  const { loading: refreshLoading, refreshCache } = useCacheRefresh();
  const { categories } = useCategories();
  const { channels, channelCategories } = useChannelNames();
  const { loading: recreateIndicesLoading, recreateIndices } = useRecreateIndices();
  const elasticsearchDown = useElasticsearchState() === 'down';
  const [onlyMissing, setOnlyMissing] = useState(false);
  // What the last "load more" brought, as a line for the live region below
  const [loadedMoreAnnouncement, setLoadedMoreAnnouncement] = useState('');
  const { t } = useTranslation();
  const focusPage = usePageFocus<HTMLElement>();
  // The landmark doubles as the target of "back to the top of the results":
  // focusing it brings the window, and a keyboard user, back to the first row.
  const mainRef = useRef<HTMLElement | null>(null);
  const setMainRef = useCallback(
    (node: HTMLElement | null) => {
      mainRef.current = node;
      focusPage(node);
    },
    [focusPage],
  );
  const { pathname, search: searchParams } = useLocation();

  // The reader's place in the results survives a trip into a video: the
  // offset and the pages come back with the same search URL.
  useListScrollRestoration({
    key: `${pathname}${searchParams}`,
    loadedCount: videos.length,
    hasMore,
    busy: resultsBusy,
    loadMore,
  });

  // The URL drives the results: a deep link, a reload and a change made in
  // the search bar all arrive here the same way.
  useEffect(() => {
    void search({ query, sort, category, channel });
  }, [search, query, sort, category, channel]);

  const handleRefreshCache = useCallback(async (): Promise<void> => {
    // The run's outcome is handled where the run lives; this only starts it
    await refreshCache(onlyMissing ? { onlyMissing: true } : undefined);
  }, [refreshCache, onlyMissing]);

  // A finished reindex changes what the index holds, so the results on screen
  // are stale. The rule lives here once and follows every run, including one
  // the shell's arrival notice started on another page's behalf.
  useEffect(
    () =>
      subscribeReindexFinished(() => {
        void search({ query, sort, category, channel });
      }),
    [search, query, sort, category, channel],
  );

  const handleReload = useCallback(async (): Promise<void> => {
    await search({ query, sort, category, channel });
  }, [search, query, sort, category, channel]);

  const handleRecreateIndices = useCallback(async (): Promise<void> => {
    await recreateIndices();
  }, [recreateIndices]);

  // An incremental load announces what it brought, once: repeating the
  // "loading" line for every page told a screen reader nothing new.
  const handleLoadMore = useCallback(() => {
    void loadMore().then((appended) => {
      if (appended > 0) {
        setLoadedMoreAnnouncement(t('search.loadedMore', { count: appended, loaded: videos.length + appended }));
      }
    });
  }, [loadMore, videos.length, t]);

  // The released rows are gone for good, so the way back to the start of the
  // results is a fresh search: it asks for offset 0 and replaces the window.
  const handleBackToTop = useCallback(() => {
    void search({ query, sort, category, channel });
    mainRef.current?.focus();
  }, [search, query, sort, category, channel]);

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
    <main id={MAIN_CONTENT_ID} className="app-main" ref={setMainRef} tabIndex={-1}>
      {/* React 19 hoists the title into <head>, so the tab names the search
          that is on screen without an effect or a routing library. */}
      <title>{title}</title>
      {/* The search bar is the page's visual anchor and the cards below carry
          the content: the heading names the page for a screen reader without
          competing with the form for attention. */}
      <h1 className="visually-hidden">{heading}</h1>
      <SearchBar
        query={query}
        sort={sort}
        category={category}
        channel={channel}
        categories={categories}
        channels={channels}
        channelCategories={channelCategories}
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
          {/* The busy region is the results, never the whole page: the search
              form stays usable and is not announced as busy per page. */}
          <div className="search-results" aria-busy={resultsBusy}>
            {(videos.length > 0 || showEmptyState) && (
              <VideoList
                videos={videos}
                searchQuery={query}
                droppedCount={droppedCount}
                onBackToTop={handleBackToTop}
              />
            )}
            {hasMore && (
              <LoadMore loading={videoLoadingMore} failed={videoError !== null} onLoadMore={handleLoadMore} />
            )}
          </div>
          <p className="visually-hidden" role="status">
            {loadedMoreAnnouncement}
          </p>
        </>
      )}
    </main>
  );
}
