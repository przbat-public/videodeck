import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { StatusResponse } from '@videodeck/shared/api';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FetchMock, MockResponse } from '../test/fetchMock';
import StatusPage from './StatusPage';

const statusResponse: StatusResponse = {
  videosFolderPath: ['/videos/a', '/videos/b'],
  folderConfigs: {
    '/videos/a': { channelUrl: 'https://yt/@a' },
    '/videos/b': null,
  },
  downloadDefaults: { maxHeight: 2160, subLangs: ['en'], writeComments: true },
  indexedFolders: ['/videos/a'],
  listExists: { '/videos/a': true, '/videos/b': false },
  status: 'ok',
};

const json = (body: unknown, status = 200): MockResponse => ({
  ok: status < 400,
  status,
  json: async () => body,
});

/**
 * StatusPage renders a FolderSection per configured path plus the global
 * queue controls — hence the routing mock rather than a single canned
 * response.
 */
function installFetch(handlers: { status?: () => MockResponse; queue?: () => MockResponse } = {}): FetchMock {
  const fetchMock: FetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/status') {
      return handlers.status?.() ?? json(statusResponse);
    }
    if (url === '/api/folder/queue') {
      return handlers.queue?.() ?? json({ jobs: [], paused: false });
    }
    if (url === '/api/folder/queue/pause?paused=1' || url === '/api/folder/queue/resume?paused=0') {
      return json({ paused: url.includes('pause') });
    }
    if (url === '/api/folder/queue/finished' && init?.method === 'DELETE') {
      return json({ cleared: 2 });
    }
    if (url.startsWith('/api/folder/list-exists')) {
      return json({ exists: false });
    }
    throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

const renderPage = () =>
  render(
    <MemoryRouter>
      <StatusPage />
    </MemoryRouter>,
  );

describe('StatusPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installFetch();
  });

  it('shows a spinner until the status arrives', () => {
    renderPage();

    expect(screen.getByText('Ładowanie statusu...')).toBeInTheDocument();
  });

  it('renders one section per configured folder', async () => {
    renderPage();

    expect(await screen.findByText('/videos/a')).toBeInTheDocument();
    expect(screen.getByText('/videos/b')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Przejdź do listy filmów' })).toHaveAttribute('href', '/videos');
  });

  it('marks only the folders whose Elasticsearch index is missing', async () => {
    renderPage();

    expect(await screen.findByText('/videos/b')).toBeInTheDocument();
    expect(screen.getByText('indeks ES: brak')).toBeInTheDocument();
    // "ready" is noise: only the actionable state is shown
    expect(screen.queryByText('indeks ES: gotowy')).toBeNull();
  });

  it('pauses and resumes the download queue', async () => {
    const user = userEvent.setup();
    const fetchMock = installFetch();
    renderPage();

    const pause = await screen.findByRole('button', { name: 'Pauza kolejki' });
    await user.click(pause);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/folder/queue/pause?paused=1', {
        method: 'POST',
      }),
    );
    expect(await screen.findByRole('button', { name: 'Wznów kolejkę' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Wznów kolejkę' }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/folder/queue/resume?paused=0', {
        method: 'POST',
      }),
    );
  });

  it('clears the finished jobs the queue keeps in memory', async () => {
    const user = userEvent.setup();
    const finishedJob = (id: string, status: 'done' | 'cancelled') => ({
      id,
      folderPath: '/videos/a',
      videoId: id,
      videoUrl: `https://yt/${id}`,
      type: 'download',
      status,
      log: [],
      logLineCount: 0,
      createdAt: '2025-01-01T00:00:00.000Z',
      finishedAt: '2025-01-01T00:01:00.000Z',
    });
    const fetchMock = installFetch({
      queue: () =>
        json({
          jobs: [finishedJob('a', 'cancelled'), finishedJob('b', 'done')],
          paused: false,
        }),
    });
    renderPage();

    const clear = await screen.findByRole('button', { name: 'Wyczyść zakończone (2)' });
    await user.click(clear);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/folder/queue/finished', { method: 'DELETE' }));
  });

  it('offers to create config.json for a folder that has none', async () => {
    renderPage();

    expect(await screen.findByText('/videos/b')).toBeInTheDocument();
    expect(screen.getByText('Plik config.json nie istnieje w tym folderze.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Utwórz config.json' })).toBeInTheDocument();
  });

  it('shows the error when the status request fails', async () => {
    installFetch({ status: () => json({ error: 'boom' }, 500) });
    renderPage();

    expect(await screen.findByText('Błąd: Nie udało się pobrać statusu')).toBeInTheDocument();
  });

  it('says so when no folders are configured', async () => {
    installFetch({
      status: () => json({ ...statusResponse, videosFolderPath: [], folderConfigs: {} }),
    });
    renderPage();

    expect(await screen.findByText('Brak skonfigurowanych ścieżek')).toBeInTheDocument();
  });
});
