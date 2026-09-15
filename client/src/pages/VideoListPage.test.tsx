import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { VideoListItem } from '@videodeck/shared/api';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FetchMock, MockResponse } from '../test/fetchMock';
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
  const fetchMock: FetchMock = vi.fn(async (url: string, init?: RequestInit): Promise<MockResponse> => {
    if (url.startsWith('/api/videos/search?')) {
      return searchResponse(handlers, url);
    }
    if (url === '/api/videos/categories') {
      return json({ categories: handlers.categories ?? CATEGORIES });
    }
    if (url === '/api/videos/channels') {
      return json({ channels: ['Kanał A'] });
    }
    if (url === '/api/videos/recreateIndices' && init?.method === 'POST') {
      return json({ message: 'Recreation started' }, 202);
    }
    if (url === '/api/videos/recreateIndices/status') {
      return json({ running: false, foldersDone: 1, foldersTotal: 1, errors: [] });
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
      <button type="button" onClick={() => navigate('/videos?category=fpv&sort=likes-desc')}>
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
          path="/videos"
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

// Real timers here (the page debounces), so interactions go through userEvent
// — fireEvent stays reserved for the fake-timer suites (SearchBar).
const user = userEvent.setup();

describe('VideoListPage', () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = installFetch();
  });

  describe('opening a URL', () => {
    it('searches exactly once with the defaults on the bare /videos URL', async () => {
      renderAt('/videos');

      expect(await screen.findByText('First')).toBeInTheDocument();
      expect(screen.getByText('1 film / 1 łącznie')).toBeInTheDocument();
      await screen.findByRole('combobox', { name: 'Kategoria' }); // categories loaded too
      await sleep(350); // past the search bar's debounce: nothing else may fire

      expect(searchUrls(fetchMock)).toEqual(['/api/videos/search?sort=date-desc&offset=0&limit=100']);
      expect(currentUrl()).toBe('/videos');
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
      renderAt('/videos?q=robot+arm&sort=views-desc&category=lego');

      expect(await screen.findByText('2 filmy / 7 łącznie')).toBeInTheDocument();
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
      renderAt('/videos?q=robot');

      const title = await screen.findByText(
        (_, element) => element?.className === 'video-title' && element.textContent === 'A robot in the garden',
      );
      expect(within(title).getByText('robot')).toHaveClass('search-highlight');
    });

    it('falls back to the default sort for an unknown one and keeps the rest', async () => {
      renderAt('/videos?q=drone&sort=bogus&category=fpv');

      await screen.findByText('First');

      expect(searchUrls(fetchMock)).toEqual([
        '/api/videos/search?q=drone&sort=date-desc&category=fpv&offset=0&limit=100',
      ]);
      expect(sortSelect()).toHaveTextContent('Najnowsze');
      expect(searchInput()).toHaveValue('drone');
    });

    it('passes channel and date filters from the URL to the search', async () => {
      fetchMock = installFetch({ search: () => ({ videos: [], totalCount: 0 }) });
      renderAt('/videos?channel=Kana%C5%82+A&dateFrom=2024-01-05&dateTo=2025-12-31');

      expect(await screen.findByText('Brak filmów. Spróbuj innego zapytania.')).toBeInTheDocument();
      expect(searchUrls(fetchMock).at(-1)).toBe(
        '/api/videos/search?sort=date-desc&channel=Kana%C5%82+A&dateFrom=20240105&dateTo=20251231&offset=0&limit=100',
      );
    });

    it('trusts a category the server does not list, and shows it in the filter', async () => {
      fetchMock = installFetch({ search: () => ({ videos: [], totalCount: 0 }) });
      renderAt('/videos?category=archive');

      expect(await screen.findByText('Brak filmów. Spróbuj innego zapytania.')).toBeInTheDocument();
      expect(searchUrls(fetchMock)).toEqual(['/api/videos/search?sort=date-desc&category=archive&offset=0&limit=100']);
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
      renderAt('/videos?category=lego');

      await screen.findByText('First');

      expect(await categorySelect()).toHaveTextContent('lego');
      expect(searchUrls(fetchMock)).toEqual(['/api/videos/search?sort=date-desc&category=lego&offset=0&limit=100']);
    });
  });

  describe('changing the form', () => {
    it('writes the chosen category to the URL and searches with it', async () => {
      renderAt('/videos');
      await screen.findByText('First');

      await pick(await categorySelect(), 'lego');

      await waitFor(() => expect(currentUrl()).toBe('/videos?category=lego'));
      await waitFor(() =>
        expect(searchUrls(fetchMock)).toEqual([
          '/api/videos/search?sort=date-desc&offset=0&limit=100',
          '/api/videos/search?sort=date-desc&category=lego&offset=0&limit=100',
        ]),
      );
    });

    it('writes the chosen sort to the URL and drops it again when back at the default', async () => {
      renderAt('/videos?q=drone');
      await screen.findByText('First');

      await pick(sortSelect(), 'Najmniej polubień');
      await waitFor(() => expect(currentUrl()).toBe('/videos?q=drone&sort=likes-asc'));

      await pick(sortSelect(), 'Najnowsze');
      await waitFor(() => expect(currentUrl()).toBe('/videos?q=drone'));

      expect(searchUrls(fetchMock)).toEqual([
        '/api/videos/search?q=drone&sort=date-desc&offset=0&limit=100',
        '/api/videos/search?q=drone&sort=likes-asc&offset=0&limit=100',
        '/api/videos/search?q=drone&sort=date-desc&offset=0&limit=100',
      ]);
    });

    it('writes a typed phrase to the URL after the pause and searches once', async () => {
      renderAt('/videos?category=fpv');
      await screen.findByText('First');

      await user.clear(searchInput());
      await user.type(searchInput(), 'motor');

      await waitFor(() => expect(currentUrl()).toBe('/videos?q=motor&category=fpv'));
      await waitFor(() =>
        expect(searchUrls(fetchMock)).toEqual([
          '/api/videos/search?sort=date-desc&category=fpv&offset=0&limit=100',
          '/api/videos/search?q=motor&sort=date-desc&category=fpv&offset=0&limit=100',
        ]),
      );
    });

    it('leaves the URL and the results alone while the phrase is too short', async () => {
      renderAt('/videos?q=drone');
      await screen.findByText('First');

      await user.clear(searchInput());
      await user.type(searchInput(), 'dr');
      await sleep(350);

      expect(searchInput()).toHaveValue('dr');
      expect(currentUrl()).toBe('/videos?q=drone');
      expect(searchUrls(fetchMock)).toEqual(['/api/videos/search?q=drone&sort=date-desc&offset=0&limit=100']);
    });

    it('returns to the bare URL when everything is cleared', async () => {
      renderAt('/videos?q=drone&sort=views-desc&category=lego');
      await screen.findByText('First');

      await user.click(screen.getByRole('button', { name: 'Wyczyść' }));
      await pick(sortSelect(), 'Najnowsze');
      await pick(await categorySelect(), 'Wszystkie kategorie');

      await waitFor(() => expect(currentUrl()).toBe('/videos'));
      await waitFor(() =>
        expect(searchUrls(fetchMock).at(-1)).toBe('/api/videos/search?sort=date-desc&offset=0&limit=100'),
      );
    });
  });

  describe('the URL changing from outside the form', () => {
    it('replaces its own history entry, so Back leaves the page instead of undoing filters', async () => {
      renderAt('/videos');
      await screen.findByText('First');

      await pick(await categorySelect(), 'lego');
      await waitFor(() => expect(currentUrl()).toBe('/videos?category=lego'));
      await pick(sortSelect(), 'Najwięcej wyświetleń');
      await waitFor(() => expect(currentUrl()).toBe('/videos?sort=views-desc&category=lego'));

      // A real push, then Back: the page's entry must hold the latest filters…
      await user.click(screen.getByRole('button', { name: 'go-elsewhere' }));
      await waitFor(() => expect(currentUrl()).toBe('/videos?category=fpv&sort=likes-desc'));
      await user.click(screen.getByRole('button', { name: 'back' }));
      await waitFor(() => expect(currentUrl()).toBe('/videos?sort=views-desc&category=lego'));
      await waitFor(() =>
        expect(searchUrls(fetchMock).at(-1)).toBe(
          '/api/videos/search?sort=views-desc&category=lego&offset=0&limit=100',
        ),
      );
      expect(sortSelect()).toHaveTextContent('Najwięcej wyświetleń');
      expect(await categorySelect()).toHaveTextContent('lego');

      // …and be the only one: another Back has nowhere earlier to go.
      await user.click(screen.getByRole('button', { name: 'back' }));
      expect(currentUrl()).toBe('/videos?sort=views-desc&category=lego');
    });

    it('re-runs the search and updates the form when navigation lands on new parameters', async () => {
      renderAt('/videos?q=drone');
      await screen.findByText('First');
      expect(searchInput()).toHaveValue('drone');

      await user.click(screen.getByRole('button', { name: 'go-elsewhere' }));

      await waitFor(() =>
        expect(searchUrls(fetchMock).at(-1)).toBe('/api/videos/search?sort=likes-desc&category=fpv&offset=0&limit=100'),
      );
      expect(searchInput()).toHaveValue('');
      expect(sortSelect()).toHaveTextContent('Najwięcej polubień');
      expect(await categorySelect()).toHaveTextContent('fpv');
      expect(currentUrl()).toBe('/videos?category=fpv&sort=likes-desc');
    });
  });

  describe('toolbar', () => {
    it('Reload repeats the search the URL describes', async () => {
      renderAt('/videos?q=drone&category=lego');
      await screen.findByText('First');

      await user.click(screen.getByRole('button', { name: 'Odśwież' }));

      await waitFor(() =>
        expect(searchUrls(fetchMock)).toEqual([
          '/api/videos/search?q=drone&sort=date-desc&category=lego&offset=0&limit=100',
          '/api/videos/search?q=drone&sort=date-desc&category=lego&offset=0&limit=100',
        ]),
      );
    });

    it('Recreate Indices posts to the reindex endpoint', async () => {
      renderAt('/videos');
      await screen.findByText('First');

      await user.click(screen.getByRole('button', { name: 'Odbuduj indeksy' }));

      await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith('/api/videos/recreateIndices', {
          method: 'POST',
          signal: expect.any(AbortSignal),
        }),
      );
    });

    it('Refresh cache can skip folders that already have an index (onlyMissing)', async () => {
      renderAt('/videos');
      await screen.findByText('First');

      await user.click(screen.getByLabelText('tylko brakujące (użyj istniejącego indeksu)'));
      await user.click(screen.getByRole('button', { name: 'Odśwież indeks' }));

      await waitFor(() =>
        expect(fetchMock.mock.calls.some(([url]) => url === '/api/videos/refreshCache?onlyMissing=1')).toBe(true),
      );
      expect(fetchMock.mock.calls.some(([url]) => url === '/api/videos/refreshCache')).toBe(false);
    });
  });

  describe('result summary', () => {
    it('pluralises the count for several videos', async () => {
      fetchMock = installFetch({
        search: () => ({ videos: [video('v1', 'First'), video('v2', 'Second')], totalCount: 5 }),
      });
      renderAt('/videos');

      expect(await screen.findByText('2 filmy / 5 łącznie')).toBeInTheDocument();
    });

    it('shows the empty-list message when nothing matches', async () => {
      fetchMock = installFetch({ search: () => ({ videos: [], totalCount: 0 }) });
      renderAt('/videos');

      expect(await screen.findByText('Brak filmów. Spróbuj innego zapytania.')).toBeInTheDocument();
    });
  });

  describe('load more', () => {
    it('offers Show more while results remain and appends the next page on click', async () => {
      fetchMock = installFetch({
        search: (params) =>
          params.get('offset') === '1'
            ? { videos: [video('v2', 'Second')], totalCount: 3 }
            : { videos: [video('v1', 'First')], totalCount: 3 },
      });
      renderAt('/videos');

      expect(await screen.findByText('First')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Pokaż więcej' }));

      expect(await screen.findByText('Second')).toBeInTheDocument();
      expect(searchUrls(fetchMock).at(-1)).toBe('/api/videos/search?sort=date-desc&offset=1&limit=100');
    });

    it('hides the button once everything is loaded', async () => {
      fetchMock = installFetch({
        search: () => ({ videos: [video('v1', 'First')], totalCount: 1 }),
      });
      renderAt('/videos');

      expect(await screen.findByText('First')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Pokaż więcej' })).toBeNull();
    });
  });
});
