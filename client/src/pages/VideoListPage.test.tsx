import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { VideoListItem } from '@videodeck/shared/api';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppLayout } from '../components/AppLayout';
import i18n from '../i18n';
import type { FetchMock, MockResponse } from '../test/fetchMock';
import { installIntersectionObserver } from '../test/intersectionObserverMock';
import { resetElasticsearchState } from '../utils/elasticsearchStatus';
import { clearListPositions } from '../utils/listScrollMemory';
import VideoListPage from './VideoListPage';

const CATEGORIES = ['fpv', 'lego'];

const video = (baseName: string, title: string): VideoListItem => ({
  baseName,
  title,
  description: 'A description',
  videoPath: `${baseName}.mp4`,
  thumbnailPath: `${baseName}.webp`,
  folderPath: '/videos/a',
  comments: [],
});

const json = (body: unknown, status = 200): MockResponse => ({
  ok: status < 400,
  status,
  json: async () => body,
});

const defaultSearchPage = () => ({ videos: [video('v1', 'First')], totalCount: 1 });

const reindexStatus = () => ({
  running: false,
  foldersDone: 0,
  foldersTotal: 0,
  filesDone: 0,
  filesTotal: 0,
  indexed: 0,
  skipped: 0,
  errors: [],
});

interface FetchHandlers {
  search?: (params: URLSearchParams) => unknown;
  categories?: string[];
  /** Body of GET /health; a test sets a degraded stack with it */
  health?: unknown;
}

function searchResponse(handlers: FetchHandlers, url: string): MockResponse {
  const params = new URLSearchParams(url.slice(url.indexOf('?') + 1));
  return json(handlers.search?.(params) ?? defaultSearchPage());
}

function refreshCacheResponse(url: string): MockResponse {
  return url.includes('status')
    ? json(reindexStatus())
    : json({ message: 'Cache refresh process started', status: 'ok' });
}

/**
 * Route fetch by URL so tests can describe server state declaratively.
 * The search handler sees the query string the page built, so a test can
 * answer differently per category or phrase.
 */
function installFetch(handlers: FetchHandlers = {}): FetchMock {
  /** The plain GETs, keyed by URL; the method-dependent ones are below */
  const routes: Record<string, () => MockResponse> = {
    '/api/health': () => json(handlers.health ?? { status: 'ok', elasticsearch: 'ok' }),
    '/api/videos/categories': () => json({ categories: handlers.categories ?? CATEGORIES }),
    '/api/videos/channels': () => json({ channels: ['Kanał A'] }),
    '/api/videos/recreateIndices/status': () => json({ running: false, foldersDone: 1, foldersTotal: 1, errors: [] }),
  };

  const fetchMock: FetchMock = vi.fn(async (url: string, init?: RequestInit): Promise<MockResponse> => {
    if (url.startsWith('/api/videos/search?')) {
      return searchResponse(handlers, url);
    }
    const route = routes[url];
    if (route !== undefined) {
      return route();
    }
    if (url === '/api/videos/recreateIndices' && init?.method === 'POST') {
      return json({ message: 'Recreation started' }, 202);
    }
    if (url.startsWith('/api/videos/refreshCache')) {
      return refreshCacheResponse(url);
    }
    throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

/** Exposes the router's view of the URL and a way to navigate from outside the page */
function RouterProbe() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <div>
      <output data-testid="url">{`${location.pathname}${location.search}`}</output>
      <button type="button" onClick={() => navigate('/?category=fpv&sort=likes-desc')}>
        go-elsewhere
      </button>
      <button type="button" onClick={() => navigate(-1)}>
        back
      </button>
    </div>
  );
}

const renderAt = (url: string) =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route
          path="/"
          element={
            <>
              <VideoListPage />
              <RouterProbe />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );

const currentUrl = () => screen.getByTestId('url').textContent;
const searchInput = () => screen.getByPlaceholderText('Szukaj filmów po opisie...');
const sortSelect = () => screen.getByRole('combobox', { name: 'Sort' });
const categorySelect = () => screen.findByRole('combobox', { name: 'Kategoria' });

/** Opens the Radix select and clicks the option with the given label */
const pick = async (select: HTMLElement, label: string) => {
  await user.click(select);
  await user.click(await screen.findByRole('option', { name: label }));
};

const searchUrls = (fetchMock: FetchMock): string[] =>
  fetchMock.mock.calls.map(([url]) => url).filter((url) => url.startsWith('/api/videos/search'));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The scroll call the page made to put the reader back where they were */
const scrollTo = vi.fn();

/** jsdom never lays anything out, so the scroll offset is pinned by hand */
function setScrollY(value: number): void {
  Object.defineProperty(window, 'scrollY', { configurable: true, value });
}

// Real timers here (the page debounces), so interactions go through userEvent
// — fireEvent stays reserved for the fake-timer suites (SearchBar).
const user = userEvent.setup();

describe('VideoListPage', () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    vi.clearAllMocks();
    resetElasticsearchState();
    // The scroll memory outlives a component on purpose, so every test starts
    // from a clean session and with a jsdom scroll call it can assert on
    clearListPositions();
    scrollTo.mockClear();
    vi.stubGlobal('scrollTo', scrollTo);
    fetchMock = installFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(window, 'scrollY');
  });

  describe('coming back to the results', () => {
    it('restores the offset and re-loads the pages the reader had', async () => {
      fetchMock = installFetch({
        search: (params) =>
          params.get('offset') === '1'
            ? { videos: [video('v2', 'Second')], totalCount: 3 }
            : { videos: [video('v1', 'First')], totalCount: 3 },
      });
      renderAt('/?q=drone');
      expect(await screen.findByText('First')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Pokaż więcej' }));
      expect(await screen.findByText('Second')).toBeInTheDocument();

      setScrollY(1500);
      await user.click(screen.getByRole('button', { name: 'go-elsewhere' }));
      await waitFor(() => expect(currentUrl()).toBe('/?category=fpv&sort=likes-desc'));
      await user.click(screen.getByRole('button', { name: 'back' }));

      // The URL the reader left comes back with the pages that were on screen
      await waitFor(() => expect(currentUrl()).toBe('/?q=drone'));
      expect(await screen.findByText('First')).toBeInTheDocument();
      expect(await screen.findByText('Second')).toBeInTheDocument();
      expect(scrollTo).toHaveBeenCalledWith(0, 1500);
    });

    it('restores the offset without fetching pages that were never loaded', async () => {
      fetchMock = installFetch({ search: () => ({ videos: [video('v1', 'First')], totalCount: 1 }) });
      renderAt('/?q=drone');
      expect(await screen.findByText('First')).toBeInTheDocument();

      setScrollY(700);
      await user.click(screen.getByRole('button', { name: 'go-elsewhere' }));
      await waitFor(() => expect(currentUrl()).toBe('/?category=fpv&sort=likes-desc'));
      await user.click(screen.getByRole('button', { name: 'back' }));
      await waitFor(() => expect(currentUrl()).toBe('/?q=drone'));
      expect(await screen.findByText('First')).toBeInTheDocument();

      await waitFor(() => expect(scrollTo).toHaveBeenCalledWith(0, 700));
      expect(searchUrls(fetchMock).filter((url) => url.includes('offset=1'))).toEqual([]);
    });

    it('leaves a search the reader has never opened at the top', async () => {
      renderAt('/?q=fresh');

      expect(await screen.findByText('First')).toBeInTheDocument();
      expect(scrollTo).not.toHaveBeenCalled();
    });
  });

  describe('opening a URL', () => {
    it('searches exactly once with the defaults on the bare / URL', async () => {
      renderAt('/');

      expect(await screen.findByText('First')).toBeInTheDocument();
      await screen.findByRole('combobox', { name: 'Kategoria' }); // categories loaded too
      await sleep(350); // past the search bar's debounce: nothing else may fire

      expect(searchUrls(fetchMock)).toEqual(['/api/videos/search?offset=0&limit=100']);
      expect(currentUrl()).toBe('/');
    });

    it('fills the form and runs the search from the URL parameters', async () => {
      fetchMock = installFetch({
        search: (params) =>
          params.get('category') === 'lego' && params.get('q') === 'robot arm'
            ? {
                videos: [video('l1', 'Lego robot arm'), video('l2', 'Robot arm v2')],
                totalCount: 7,
              }
            : { videos: [], totalCount: 0 },
      });
      renderAt('/?q=robot+arm&sort=views-desc&category=lego');

      expect(searchUrls(fetchMock)).toEqual([
        '/api/videos/search?q=robot+arm&sort=views-desc&category=lego&offset=0&limit=100',
      ]);

      expect(searchInput()).toHaveValue('robot arm');
      expect(sortSelect()).toHaveTextContent('Najwięcej wyświetleń');
      expect(await categorySelect()).toHaveTextContent('lego');
    });

    it('highlights the phrase from the URL in the results', async () => {
      fetchMock = installFetch({
        search: () => ({ videos: [video('v1', 'A robot in the garden')], totalCount: 1 }),
      });
      renderAt('/?q=robot');

      const title = await screen.findByText(
        (_, element) => element?.className === 'video-title' && element.textContent === 'A robot in the garden',
      );
      expect(within(title).getByText('robot')).toHaveClass('search-highlight');
    });

    it('falls back to the default sort for an unknown one and keeps the rest', async () => {
      renderAt('/?q=drone&sort=bogus&category=fpv');

      await screen.findByText('First');

      expect(searchUrls(fetchMock)).toEqual(['/api/videos/search?q=drone&category=fpv&offset=0&limit=100']);
      expect(sortSelect()).toHaveTextContent('Najnowsze');
      expect(searchInput()).toHaveValue('drone');
    });

    it('passes the channel filter from the URL to the search and ignores the legacy date params', async () => {
      fetchMock = installFetch({ search: () => ({ videos: [], totalCount: 0 }) });
      renderAt('/?channel=Kana%C5%82+A&dateFrom=2024-01-05&dateTo=2025-12-31');

      expect(await screen.findByText('Brak filmów. Spróbuj innego zapytania.')).toBeInTheDocument();
      expect(searchUrls(fetchMock).at(-1)).toBe('/api/videos/search?channel=Kana%C5%82+A&offset=0&limit=100');
    });

    it('trusts a category the server does not list, and shows it in the filter', async () => {
      fetchMock = installFetch({ search: () => ({ videos: [], totalCount: 0 }) });
      renderAt('/?category=archive');

      expect(await screen.findByText('Brak filmów. Spróbuj innego zapytania.')).toBeInTheDocument();
      expect(searchUrls(fetchMock)).toEqual(['/api/videos/search?category=archive&offset=0&limit=100']);
      expect(await categorySelect()).toHaveTextContent('archive');
    });

    it('keeps the URL filter visible when the category list fails to load', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {
        /* silence the expected categories-error log */
      });
      const base = installFetch();
      fetchMock = vi.fn(async (url: string, init?: RequestInit) =>
        url === '/api/videos/categories' ? json({ error: 'boom' }, 500) : base(url, init),
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      renderAt('/?category=lego');

      await screen.findByText('First');

      expect(await categorySelect()).toHaveTextContent('lego');
      expect(searchUrls(fetchMock)).toEqual(['/api/videos/search?category=lego&offset=0&limit=100']);
    });
  });

  describe('changing the form', () => {
    it('writes the chosen category to the URL and searches with it', async () => {
      renderAt('/');
      await screen.findByText('First');

      await pick(await categorySelect(), 'lego');

      await waitFor(() => expect(currentUrl()).toBe('/?category=lego'));
      await waitFor(() =>
        expect(searchUrls(fetchMock)).toEqual([
          '/api/videos/search?offset=0&limit=100',
          '/api/videos/search?category=lego&offset=0&limit=100',
        ]),
      );
    });

    it('writes the chosen sort to the URL and drops it again when back at the default', async () => {
      renderAt('/?q=drone');
      await screen.findByText('First');

      await pick(sortSelect(), 'Najmniej polubień');
      await waitFor(() => expect(currentUrl()).toBe('/?q=drone&sort=likes-asc'));

      await pick(sortSelect(), 'Najnowsze');
      await waitFor(() => expect(currentUrl()).toBe('/?q=drone'));

      expect(searchUrls(fetchMock)).toEqual([
        '/api/videos/search?q=drone&offset=0&limit=100',
        '/api/videos/search?q=drone&sort=likes-asc&offset=0&limit=100',
        '/api/videos/search?q=drone&offset=0&limit=100',
      ]);
    });

    it('writes a typed phrase to the URL after the pause and searches once', async () => {
      renderAt('/?category=fpv');
      await screen.findByText('First');

      await user.clear(searchInput());
      await user.type(searchInput(), 'motor');

      await waitFor(() => expect(currentUrl()).toBe('/?q=motor&category=fpv'));
      await waitFor(() =>
        expect(searchUrls(fetchMock)).toEqual([
          '/api/videos/search?category=fpv&offset=0&limit=100',
          '/api/videos/search?q=motor&category=fpv&offset=0&limit=100',
        ]),
      );
    });

    it('leaves the URL and the results alone while the phrase is too short', async () => {
      renderAt('/?q=drone');
      await screen.findByText('First');

      await user.clear(searchInput());
      await user.type(searchInput(), 'dr');
      await sleep(350);

      expect(searchInput()).toHaveValue('dr');
      expect(currentUrl()).toBe('/?q=drone');
      expect(searchUrls(fetchMock)).toEqual(['/api/videos/search?q=drone&offset=0&limit=100']);
    });

    it('returns to the bare URL when everything is cleared', async () => {
      renderAt('/?q=drone&sort=views-desc&category=lego');
      await screen.findByText('First');

      await user.click(screen.getByRole('button', { name: 'Wyczyść' }));
      await pick(sortSelect(), 'Najnowsze');
      await pick(await categorySelect(), 'Wszystkie kategorie');

      await waitFor(() => expect(currentUrl()).toBe('/'));
      await waitFor(() => expect(searchUrls(fetchMock).at(-1)).toBe('/api/videos/search?offset=0&limit=100'));
    });
  });

  describe('the URL changing from outside the form', () => {
    it('replaces its own history entry, so Back leaves the page instead of undoing filters', async () => {
      renderAt('/');
      await screen.findByText('First');

      await pick(await categorySelect(), 'lego');
      await waitFor(() => expect(currentUrl()).toBe('/?category=lego'));
      await pick(sortSelect(), 'Najwięcej wyświetleń');
      await waitFor(() => expect(currentUrl()).toBe('/?sort=views-desc&category=lego'));

      // A real push, then Back: the page's entry must hold the latest filters…
      await user.click(screen.getByRole('button', { name: 'go-elsewhere' }));
      await waitFor(() => expect(currentUrl()).toBe('/?category=fpv&sort=likes-desc'));
      await user.click(screen.getByRole('button', { name: 'back' }));
      await waitFor(() => expect(currentUrl()).toBe('/?sort=views-desc&category=lego'));
      await waitFor(() =>
        expect(searchUrls(fetchMock).at(-1)).toBe(
          '/api/videos/search?sort=views-desc&category=lego&offset=0&limit=100',
        ),
      );
      expect(sortSelect()).toHaveTextContent('Najwięcej wyświetleń');
      expect(await categorySelect()).toHaveTextContent('lego');

      // …and be the only one: another Back has nowhere earlier to go.
      await user.click(screen.getByRole('button', { name: 'back' }));
      expect(currentUrl()).toBe('/?sort=views-desc&category=lego');
    });

    it('re-runs the search and updates the form when navigation lands on new parameters', async () => {
      renderAt('/?q=drone');
      await screen.findByText('First');
      expect(searchInput()).toHaveValue('drone');

      await user.click(screen.getByRole('button', { name: 'go-elsewhere' }));

      await waitFor(() =>
        expect(searchUrls(fetchMock).at(-1)).toBe('/api/videos/search?sort=likes-desc&category=fpv&offset=0&limit=100'),
      );
      expect(searchInput()).toHaveValue('');
      expect(sortSelect()).toHaveTextContent('Najwięcej polubień');
      expect(await categorySelect()).toHaveTextContent('fpv');
      expect(currentUrl()).toBe('/?category=fpv&sort=likes-desc');
    });
  });

  describe('top bar menu', () => {
    const renderWithMenu = (url: string) =>
      render(
        <MemoryRouter initialEntries={[url]}>
          <Routes>
            <Route path="/" element={<AppLayout />}>
              <Route
                index
                element={
                  <>
                    <VideoListPage />
                    <RouterProbe />
                  </>
                }
              />
            </Route>
          </Routes>
        </MemoryRouter>,
      );

    const openMenu = async () => {
      await user.click(screen.getByRole('button', { name: 'Menu aplikacji' }));
    };

    it('Reload results repeats the search the URL describes', async () => {
      renderWithMenu('/?q=drone&category=lego');
      await screen.findByText('First');

      await openMenu();
      await user.click(await screen.findByRole('menuitem', { name: 'Odśwież wyniki' }));

      await waitFor(() =>
        expect(searchUrls(fetchMock)).toEqual([
          '/api/videos/search?q=drone&category=lego&offset=0&limit=100',
          '/api/videos/search?q=drone&category=lego&offset=0&limit=100',
        ]),
      );
    });

    it('Recreate Indices posts to the reindex endpoint', async () => {
      renderWithMenu('/');
      await screen.findByText('First');

      await openMenu();
      await user.click(await screen.findByRole('menuitem', { name: 'Odbuduj indeksy' }));

      await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith('/api/videos/recreateIndices', {
          method: 'POST',
          signal: expect.any(AbortSignal),
        }),
      );
    });

    it('turns the index actions off while Elasticsearch is down', async () => {
      installFetch({ health: { status: 'degraded', elasticsearch: 'down' } });
      renderWithMenu('/');
      await screen.findByText('First');
      // The banner is rendered by the shell and names the state
      await screen.findByText(/Elasticsearch nie odpowiada/);

      await openMenu();

      // Radix marks a disabled item with data-disabled, not the disabled property
      expect(await screen.findByRole('menuitem', { name: 'Odśwież indeks' })).toHaveAttribute('data-disabled');
      expect(await screen.findByRole('menuitem', { name: 'Odbuduj indeksy' })).toHaveAttribute('data-disabled');
    });

    it('Refresh cache can skip folders that already have an index (onlyMissing)', async () => {
      renderWithMenu('/');
      await screen.findByText('First');

      await openMenu();
      await user.click(
        await screen.findByRole('menuitemcheckbox', { name: 'tylko brakujące (użyj istniejącego indeksu)' }),
      );
      await user.click(await screen.findByRole('menuitem', { name: 'Odśwież indeks' }));

      await waitFor(() =>
        expect(fetchMock.mock.calls.some(([url]) => url === '/api/videos/refreshCache?onlyMissing=1')).toBe(true),
      );
      expect(fetchMock.mock.calls.some(([url]) => url === '/api/videos/refreshCache')).toBe(false);
    });
  });

  describe('result summary', () => {
    it('shows the empty-list message when nothing matches', async () => {
      fetchMock = installFetch({ search: () => ({ videos: [], totalCount: 0 }) });
      renderAt('/');

      expect(await screen.findByText('Brak filmów. Spróbuj innego zapytania.')).toBeInTheDocument();
    });

    it('shows the failure instead of the empty list when the search fails', async () => {
      const base = installFetch();
      fetchMock = vi.fn(async (url: string, init?: RequestInit) =>
        url.startsWith('/api/videos/search?') ? json({ error: 'boom' }, 500) : base(url, init),
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      renderAt('/?q=drone');

      expect(await screen.findByText('Błąd: Nie udało się wyszukać filmów')).toBeInTheDocument();
      // "Nothing matched" is a lie when the request never produced an answer.
      expect(screen.queryByText('Brak filmów. Spróbuj innego zapytania.')).toBeNull();
    });
  });

  describe('load more', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('loads the next page by itself when the end of the list scrolls into view', async () => {
      const observers = installIntersectionObserver();
      fetchMock = installFetch({
        search: (params) =>
          params.get('offset') === '1'
            ? { videos: [video('v2', 'Second')], totalCount: 2 }
            : { videos: [video('v1', 'First')], totalCount: 2 },
      });
      renderAt('/');
      expect(await screen.findByText('First')).toBeInTheDocument();

      act(() => observers.at(-1)?.trigger(true));

      expect(await screen.findByText('Second')).toBeInTheDocument();
      expect(searchUrls(fetchMock).at(-1)).toBe('/api/videos/search?offset=1&limit=100');
      // Everything is loaded: nothing is left to watch
      expect(observers.every((observer) => observer.disconnected)).toBe(true);
    });

    it('stops loading by itself after a failed page and leaves the retry to the button', async () => {
      const observers = installIntersectionObserver();
      const base = installFetch({
        search: () => ({ videos: [video('v1', 'First')], totalCount: 3 }),
      });
      fetchMock = vi.fn(async (url: string, init?: RequestInit) =>
        url.includes('offset=1') ? json({ error: 'boom' }, 500) : base(url, init),
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      renderAt('/');
      expect(await screen.findByText('First')).toBeInTheDocument();

      act(() => observers.at(-1)?.trigger(true));

      expect(await screen.findByText('Błąd: Nie udało się wyszukać filmów')).toBeInTheDocument();
      // A server that just failed would be hammered by a retry per scroll
      expect(observers.every((observer) => observer.disconnected)).toBe(true);
      expect(screen.getByRole('button', { name: 'Pokaż więcej' })).toBeInTheDocument();
    });

    it('offers Show more while results remain and appends the next page on click', async () => {
      fetchMock = installFetch({
        search: (params) =>
          params.get('offset') === '1'
            ? { videos: [video('v2', 'Second')], totalCount: 3 }
            : { videos: [video('v1', 'First')], totalCount: 3 },
      });
      renderAt('/');

      expect(await screen.findByText('First')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Pokaż więcej' }));

      expect(await screen.findByText('Second')).toBeInTheDocument();
      expect(searchUrls(fetchMock).at(-1)).toBe('/api/videos/search?offset=1&limit=100');
    });

    it('hides the button once everything is loaded', async () => {
      fetchMock = installFetch({
        search: () => ({ videos: [video('v1', 'First')], totalCount: 1 }),
      });
      renderAt('/');

      expect(await screen.findByText('First')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Pokaż więcej' })).toBeNull();
    });

    it('keeps the page already shown when loading more fails', async () => {
      const base = installFetch({
        search: (params) =>
          params.get('offset') === '0'
            ? { videos: [video('v1', 'First')], totalCount: 3 }
            : { videos: [], totalCount: 3 },
      });
      fetchMock = vi.fn(async (url: string, init?: RequestInit) =>
        url.includes('offset=1') ? json({ error: 'boom' }, 500) : base(url, init),
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      renderAt('/');
      expect(await screen.findByText('First')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Pokaż więcej' }));

      expect(await screen.findByText('Błąd: Nie udało się wyszukać filmów')).toBeInTheDocument();
      expect(screen.getByText('First')).toBeInTheDocument();
      // The failed page can be asked for again.
      expect(screen.getByRole('button', { name: 'Pokaż więcej' })).toBeInTheDocument();
    });

    it('keeps the busy state on the results list instead of the whole page', async () => {
      let releaseSecondPage: (() => void) | undefined;
      const base = installFetch({
        search: (params) =>
          params.get('offset') === '1'
            ? { videos: [video('v2', 'Second')], totalCount: 3 }
            : { videos: [video('v1', 'First')], totalCount: 3 },
      });
      fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes('offset=1')) {
          await new Promise<void>((resolve) => {
            releaseSecondPage = resolve;
          });
        }
        return base(url, init);
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      renderAt('/');
      expect(await screen.findByText('First')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Pokaż więcej' }));

      // The results are the busy region, not the page: the search form stays
      // usable and is not announced as busy with every page.
      const main = screen.getByRole('main');
      const results = main.querySelector('[aria-busy]');
      expect(main).not.toHaveAttribute('aria-busy');
      expect(results).toHaveAttribute('aria-busy', 'true');
      expect(within(results as HTMLElement).getByText('First')).toBeInTheDocument();
      expect(within(results as HTMLElement).queryByLabelText('Fraza wyszukiwania')).toBeNull();

      releaseSecondPage?.();
      expect(await screen.findByText('Second')).toBeInTheDocument();
      await waitFor(() => expect(results).toHaveAttribute('aria-busy', 'false'));
    });

    it('announces what an incremental load brought instead of the loading text per page', async () => {
      const titles = ['First', 'Second', 'Third'];
      fetchMock = installFetch({
        search: (params) => {
          const offset = Number(params.get('offset') ?? '0');
          return { videos: [video(`v${offset + 1}`, titles[offset] ?? 'Later')], totalCount: 3 };
        },
      });
      renderAt('/');
      expect(await screen.findByText('First')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Pokaż więcej' }));

      expect(await screen.findByText('Second')).toBeInTheDocument();
      // The incremental load never repeats the "loading" announcement ...
      expect(screen.queryByText(i18n.t('search.loading'))).toBeNull();
      // ... it announces what arrived, once
      expect(within(screen.getByRole('main')).getByRole('status')).toHaveTextContent(
        i18n.t('search.loadedMore', { count: 1, loaded: 2 }),
      );

      await user.click(screen.getByRole('button', { name: 'Pokaż więcej' }));

      expect(await screen.findByText('Third')).toBeInTheDocument();
      expect(screen.queryByText(i18n.t('search.loading'))).toBeNull();
      expect(within(screen.getByRole('main')).getByRole('status')).toHaveTextContent(
        i18n.t('search.loadedMore', { count: 1, loaded: 3 }),
      );
    });
  });
});
