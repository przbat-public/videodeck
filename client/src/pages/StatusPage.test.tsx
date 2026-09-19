import { render, screen, waitFor, within } from '@testing-library/react';
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
function installFetch(
  handlers: {
    status?: () => MockResponse;
    queue?: () => MockResponse;
    summaries?: () => MockResponse;
    list?: () => MockResponse;
  } = {},
): FetchMock {
  // One table per method keeps the dispatcher flat: `/api/folder/queue` alone
  // answers a GET (the queue) and a POST (an enqueue).
  const methodRoutes: Record<string, () => MockResponse> = {
    'POST /api/folder/queue': () => json({ jobs: [], skipped: [] }),
    'POST /api/folder/download-playlist': () => json({ output: 'ok' }),
    'DELETE /api/folder/queue/finished': () => json({ cleared: 2 }),
  };
  const routes: Record<string, () => MockResponse> = {
    '/api/status': () => handlers.status?.() ?? json(statusResponse),
    '/api/folder/summaries': () => handlers.summaries?.() ?? json({ summaries: {} }),
    '/api/folder/queue': () => handlers.queue?.() ?? json({ jobs: [], paused: false }),
    '/api/folder/queue/pause?paused=1': () => json({ paused: true }),
    '/api/folder/queue/resume?paused=0': () => json({ paused: false }),
  };

  const fetchMock: FetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const byMethod = methodRoutes[`${init?.method ?? 'GET'} ${url}`];
    if (byMethod !== undefined) {
      return byMethod();
    }
    const handler = routes[url];
    if (handler !== undefined) {
      return handler();
    }
    if (url.startsWith('/api/folder/list?')) {
      return handlers.list?.() ?? json({ videos: [], downloadStatuses: {}, lastUpdatedDates: {} });
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

  it('renders one row per configured folder', async () => {
    renderPage();

    expect(await screen.findByText('/videos/a')).toBeInTheDocument();
    expect(screen.getByText('/videos/b')).toBeInTheDocument();
    expect(screen.getAllByRole('columnheader').map((header) => header.textContent?.trim())).toEqual([
      'Kanał',
      'Filmy',
      'Kolejka',
      'Akcje',
    ]);
  });

  it('chips only the folders whose Elasticsearch index is missing', async () => {
    renderPage();

    expect(await screen.findByText('/videos/b')).toBeInTheDocument();
    expect(screen.getByText('brak indeksu ES')).toBeInTheDocument();
    // The console shows the actionable state only, never a "ready" badge
    expect(screen.queryByText('indeks ES: gotowy')).toBeNull();
  });

  it('shows the counts and the queue state of every channel', async () => {
    installFetch({
      summaries: () =>
        json({
          summaries: {
            '/videos/a': { videos: 40, downloaded: 2, notDownloaded: 38, stale: 5 },
            '/videos/b': { videos: 0, downloaded: 0, notDownloaded: 0, stale: 0 },
          },
        }),
      queue: () =>
        json({
          paused: false,
          jobs: [
            {
              id: 'job-1',
              folderPath: '/videos/a',
              videoId: 'v1',
              videoUrl: 'https://yt/v1',
              type: 'download',
              status: 'error',
              error: 'yt-dlp exited with code 1',
              log: [],
              logLineCount: 0,
              createdAt: '2026-09-19T10:00:00.000Z',
            },
          ],
        }),
    });
    renderPage();

    expect(await screen.findByText('40 filmów')).toBeInTheDocument();
    expect(screen.getByText('38 niepobranych')).toBeInTheDocument();
    expect(screen.getByText('5 nie zaktualizowanych od miesiąca')).toBeInTheDocument();
    expect(screen.getByText('1 błąd')).toBeInTheDocument();
    // One channel has no counts of its own, so it shows none
    expect(screen.getByText('0 filmów')).toBeInTheDocument();
  });

  it('filters the rows from the toolbar and keeps the filter in the URL', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('/videos/a');

    await user.click(screen.getByRole('button', { name: /Wymaga uwagi/ }));

    // /videos/b has no index, so it is the one that needs attention
    expect(screen.getByText('/videos/b')).toBeInTheDocument();
    expect(screen.queryByText('/videos/a')).toBeNull();
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

  it('opens the full folder section under the row the URL expands', async () => {
    const user = userEvent.setup();
    renderPage();
    const rowB = (await screen.findByText('/videos/b')).closest('tr');
    expect(rowB).not.toBeNull();

    await user.click(within(rowB as HTMLElement).getByRole('button', { name: 'Pokaż filmy' }));

    expect(await screen.findByText('Plik config.json nie istnieje w tym folderze.')).toBeInTheDocument();
    // No edit button of its own any more: the row menu owns that entry point
    expect(screen.queryByRole('button', { name: 'Utwórz config.json' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edytuj konfigurację' })).toBeNull();
    // ... and the row above already shows the path, so the section has no header
    expect(screen.queryByRole('heading', { name: '/videos/b' })).toBeNull();
  });

  it('opens the config form from the row menu', async () => {
    const user = userEvent.setup();
    renderPage();
    const rowA = (await screen.findByText('/videos/a')).closest('tr');
    expect(rowA).not.toBeNull();

    await user.click(within(rowA as HTMLElement).getByRole('button', { name: 'Więcej akcji' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Edytuj config.json' }));

    expect(await screen.findByLabelText('Adres kanału YouTube:')).toHaveValue('https://yt/@a');
    expect(screen.getByRole('button', { name: 'Zapisz' })).toBeInTheDocument();
  });

  it('closes the config form when the editor is cancelled', async () => {
    const user = userEvent.setup();
    renderPage();
    const rowA = (await screen.findByText('/videos/a')).closest('tr');
    expect(rowA).not.toBeNull();

    await user.click(within(rowA as HTMLElement).getByRole('button', { name: 'Więcej akcji' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Edytuj config.json' }));
    const channelUrl = await screen.findByLabelText('Adres kanału YouTube:');

    await user.click(screen.getByRole('button', { name: 'Anuluj' }));

    expect(screen.queryByLabelText('Adres kanału YouTube:')).toBeNull();
    expect(channelUrl).not.toBeInTheDocument();
  });

  it('checks list.json for a folder the status did not report', async () => {
    const user = userEvent.setup();
    const fetchMock = installFetch({
      status: () =>
        json({
          ...statusResponse,
          folderConfigs: {
            '/videos/a': { channelUrl: 'https://yt/@a' },
            '/videos/b': { channelUrl: 'https://yt/@b' },
          },
          listExists: {},
        }),
    });
    renderPage();
    const rowA = (await screen.findByText('/videos/a')).closest('tr');
    expect(rowA).not.toBeNull();

    await user.click(within(rowA as HTMLElement).getByRole('button', { name: 'Pokaż filmy' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/folder/list-exists?folderPath=%2Fvideos%2Fa'));
  });

  it('says so when the per-channel counts cannot be read', async () => {
    installFetch({ summaries: () => json({ error: 'boom' }, 500) });
    renderPage();

    expect(
      await screen.findByText('Nie udało się policzyć filmów: Nie udało się policzyć filmów w kanałach'),
    ).toBeInTheDocument();
  });

  it('shows why the queue controls are unusable when the queue read fails', async () => {
    installFetch({ queue: () => json({ error: 'boom' }, 500) });
    renderPage();

    expect(await screen.findByText('Błąd kolejki: Nie udało się wczytać kolejki')).toBeInTheDocument();
  });

  it('shows the error when the status request fails', async () => {
    installFetch({ status: () => json({ error: 'boom' }, 500) });
    renderPage();

    expect(await screen.findByText('Błąd: Nie udało się pobrać statusu')).toBeInTheDocument();
  });

  it('retries the failed status request without a page reload', async () => {
    let failNext = true;
    installFetch({
      status: () => {
        if (failNext) {
          failNext = false;
          return json({ error: 'boom' }, 500);
        }
        return json(statusResponse);
      },
    });
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Błąd: Nie udało się pobrać statusu');

    await user.click(screen.getByRole('button', { name: 'Spróbuj ponownie' }));

    expect(await screen.findByText('/videos/a')).toBeInTheDocument();
    expect(screen.queryByText('Błąd: Nie udało się pobrać statusu')).toBeNull();
  });

  it('says so when no folders are configured', async () => {
    installFetch({
      status: () => json({ ...statusResponse, videosFolderPath: [], folderConfigs: {} }),
    });
    renderPage();

    expect(await screen.findByText('Brak skonfigurowanych ścieżek')).toBeInTheDocument();
  });

  it('queues a channel from its row and refreshes the queue and the counts', async () => {
    const user = userEvent.setup();
    let summariesCalls = 0;
    let queueCalls = 0;
    const fetchMock = installFetch({
      summaries: () => {
        summariesCalls += 1;
        return json({
          summaries: { '/videos/a': { videos: 3, downloaded: 0, notDownloaded: 3, stale: 0 } },
        });
      },
      queue: () => {
        queueCalls += 1;
        return json({ jobs: [], paused: false });
      },
      list: () =>
        json({
          videos: [{ id: 'v1', title: 'Film 1', url: 'https://yt/v1' }],
          downloadStatuses: {},
          lastUpdatedDates: {},
        }),
    });
    renderPage();
    await screen.findByText('3 filmów');
    // Count only what the action causes: the mount already read both once
    // (the console hook and the queue bar poll the same endpoint).
    summariesCalls = 0;
    queueCalls = 0;

    const rowA = (await screen.findByText('/videos/a')).closest('tr');
    expect(rowA).not.toBeNull();
    await user.click(within(rowA as HTMLElement).getByRole('button', { name: 'Więcej akcji' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Pobierz wszystkie' }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/folder/queue', expect.objectContaining({ method: 'POST' })),
    );
    await waitFor(() => expect(summariesCalls).toBeGreaterThan(0));
    expect(queueCalls).toBeGreaterThan(0);
  });

  it('fetches a playlist from a row with no list and reloads the status', async () => {
    const user = userEvent.setup();
    let statusCalls = 0;
    const fetchMock = installFetch({
      status: () => {
        statusCalls += 1;
        return json({
          ...statusResponse,
          // Both folders are configured; only /videos/a already has a list
          folderConfigs: {
            '/videos/a': { channelUrl: 'https://yt/@a' },
            '/videos/b': { channelUrl: 'https://yt/@b' },
          },
        });
      },
    });
    renderPage();
    const rowB = (await screen.findByText('/videos/b')).closest('tr');
    expect(rowB).not.toBeNull();

    await user.click(within(rowB as HTMLElement).getByRole('button', { name: 'Więcej akcji' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Pobierz playlistę' }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/folder/download-playlist',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    await waitFor(() => expect(statusCalls).toBeGreaterThan(1));
  });
});
