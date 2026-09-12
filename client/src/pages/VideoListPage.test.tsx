import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { VideoListItem } from '@shared/api';
import VideoListPage from './VideoListPage';
import type { FetchMock, MockResponse } from '../test/fetchMock';

vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn(), loading: vi.fn(() => 'toast-id') },
}));

const SEARCH_URL = '/api/videos/search?sort=date-desc';

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

/** Route fetch by URL so tests can describe server state declaratively */
function installFetch(handlers: { search?: () => unknown } = {}): FetchMock {
  const fetchMock: FetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith('/api/videos/search')) {
      return json(handlers.search?.() ?? { videos: [video('v1', 'First')], totalCount: 1 });
    }
    if (url === '/api/videos/recreateIndices' && init?.method === 'POST') {
      return json({ message: 'Recreation started' }, 202);
    }
    throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

const renderPage = () =>
  render(
    <MemoryRouter>
      <VideoListPage />
    </MemoryRouter>
  );

describe('VideoListPage', () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = installFetch();
  });

  it('searches on mount and shows the result count', async () => {
    renderPage();

    expect(await screen.findByText('First')).toBeInTheDocument();
    expect(screen.getByText('1 video / 1 total')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(SEARCH_URL);
  });

  it('pluralises the count for several videos', async () => {
    fetchMock = installFetch({
      search: () => ({ videos: [video('v1', 'First'), video('v2', 'Second')], totalCount: 5 }),
    });
    renderPage();

    expect(await screen.findByText('2 videos / 5 total')).toBeInTheDocument();
  });

  it('shows the empty-list message when nothing matches', async () => {
    fetchMock = installFetch({ search: () => ({ videos: [], totalCount: 0 }) });
    renderPage();

    expect(
      await screen.findByText('No videos found. Try a different search query.')
    ).toBeInTheDocument();
  });

  it('Reload runs the search again', async () => {
    renderPage();
    await screen.findByText('First');
    const searchCalls = () =>
      fetchMock.mock.calls.filter(([url]) => url.startsWith('/api/videos/search')).length;
    const before = searchCalls();

    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));

    await waitFor(() => expect(searchCalls()).toBe(before + 1));
  });

  it('Recreate Indices posts to the reindex endpoint', async () => {
    renderPage();
    await screen.findByText('First');

    fireEvent.click(screen.getByRole('button', { name: 'Recreate Indices' }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/videos/recreateIndices', { method: 'POST' })
    );
  });
});
