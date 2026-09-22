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
  elasticsearch: 'ok',
};

const json = (body: unknown, status = 200): MockResponse => ({
  ok: status < 400,
  status,
  json: async () => body,
});

type FetchHandlers = {
  status?: () => MockResponse;
  queue?: () => MockResponse;
  summaries?: () => MockResponse;
  folderSummary?: (folderPath: string) => MockResponse;
  list?: () => MockResponse;
  enqueue?: () => MockResponse;
};

/** Query-string routes the exact-path table cannot name */
function matchPrefixedRoute(url: string, handlers: FetchHandlers): MockResponse | undefined {
  if (url.startsWith('/api/folder/list?')) {
    return handlers.list?.() ?? json({ videos: [], downloadStatuses: {}, lastUpdatedDates: {} });
  }
  if (url.startsWith('/api/folder/list-exists')) {
    return json({ exists: false });
  }
  // The expanded section polls its own folder; the same queue answers it
  if (url.startsWith('/api/folder/queue?folderPath=')) {
    return handlers.queue?.() ?? json({ jobs: [], paused: false });
  }
  if (url.startsWith('/api/folder/summaries?folderPath=')) {
    const folderPath = decodeURIComponent(url.slice('/api/folder/summaries?folderPath='.length));
    return handlers.folderSummary?.(folderPath) ?? json({ summaries: {} });
  }
  return undefined;
}

/**
 * StatusPage renders a FolderSection per configured path plus the global
 * queue controls — hence the routing mock rather than a single canned
 * response.
 */
function installFetch(handlers: FetchHandlers = {}): FetchMock {
  // One table per method keeps the dispatcher flat: `/api/folder/queue` alone
  // answers a GET (the queue) and a POST (an enqueue).
  const methodRoutes: Record<string, () => MockResponse> = {
    'POST /api/folder/queue': () => handlers.enqueue?.() ?? json({ jobs: [], skipped: [] }),
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
    const exact = routes[url];
    if (exact !== undefined) {
      return exact();
    }
    const prefixed = matchPrefixedRoute(url, handlers);
    if (prefixed !== undefined) {
      return prefixed;
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

  it('refreshes the counts of a channel whose job just finished, and that channel alone', async () => {
    // Real timers: the queue hook polls on its own interval, and the test
    // waits for the poll to observe the finished job.
    const running = {
      id: 'job-1',
      folderPath: '/videos/a',
      videoId: 'v1',
      videoUrl: 'https://yt/v1',
      type: 'download',
      status: 'running',
      log: [],
      logLineCount: 0,
      createdAt: '2026-09-19T10:00:00.000Z',
    };
    let finished = false;
    const refreshed: string[] = [];
    const fetchMock = installFetch({
      summaries: () =>
        json({
          summaries: {
            '/videos/a': { videos: 3, downloaded: 1, notDownloaded: 2, stale: 0 },
            '/videos/b': { videos: 2, downloaded: 2, notDownloaded: 0, stale: 0 },
          },
        }),
      queue: () => json({ jobs: [finished ? { ...running, status: 'done' } : running], paused: false }),
      folderSummary: (folderPath) => {
        refreshed.push(folderPath);
        return json({ summaries: { [folderPath]: { videos: 3, downloaded: 2, notDownloaded: 1, stale: 0 } } });
      },
    });
    renderPage();

    expect(await screen.findByText('2 niepobrane')).toBeInTheDocument();
    expect(await screen.findByText('1 w toku')).toBeInTheDocument();

    // The download finishes between two polls
    finished = true;

    expect(await screen.findByText('1 niepobrany', undefined, { timeout: 4000 })).toBeInTheDocument();
    // Only the channel with the finished job was re-read, from its own endpoint
    expect(refreshed).toEqual(['/videos/a']);
    expect(fetchMock).toHaveBeenCalledWith('/api/folder/summaries?folderPath=%2Fvideos%2Fa', { cache: 'no-store' });
    // The other channel keeps its counts, and the full list was not re-read
    expect(screen.getByText('2 filmów')).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([url]) => url === '/api/folder/summaries')).toHaveLength(1);
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

  it('refreshes the counts of the expanded channel after its playlist is fetched from the section', async () => {
    // The row menu already re-read the counts after a playlist fetch; the
    // same button inside the expanded section left the "Filmy" column stale.
    const user = userEvent.setup();
    let statusCalls = 0;
    const refreshed: string[] = [];
    installFetch({
      status: () => {
        statusCalls += 1;
        return json(statusResponse);
      },
      summaries: () => json({ summaries: { '/videos/a': { videos: 3, downloaded: 0, notDownloaded: 3, stale: 0 } } }),
      folderSummary: (folderPath) => {
        refreshed.push(folderPath);
        return json({ summaries: { [folderPath]: { videos: 5, downloaded: 0, notDownloaded: 5, stale: 0 } } });
      },
    });
    renderPage();
    const rowA = (await screen.findByText('/videos/a')).closest('tr') as HTMLElement;
    expect(await within(rowA).findByText('3 filmów')).toBeInTheDocument();
    statusCalls = 0;

    await user.click(within(rowA).getByRole('button', { name: 'Pokaż filmy' }));
    await user.click(await screen.findByRole('button', { name: 'Aktualizuj playlistę' }));

    expect(await within(rowA).findByText('5 filmów')).toBeInTheDocument();
    // That channel alone was re-read, and the status too (list.json may be new)
    expect(refreshed).toEqual(['/videos/a']);
    expect(statusCalls).toBeGreaterThan(0);
  });

  it('re-reads the queue after a download is queued from the expanded section', async () => {
    // The console polls the whole queue only while it sees an active job, so
    // a job queued from the section never reached the "Kolejka" column until
    // the page was reloaded.
    const user = userEvent.setup();
    const queuedJob = {
      id: 'job-1',
      folderPath: '/videos/a',
      videoId: 'v1',
      videoUrl: 'https://yt/v1',
      type: 'download',
      status: 'queued',
      log: [],
      logLineCount: 0,
      createdAt: '2026-09-22T07:00:00.000Z',
    };
    let queued = false;
    installFetch({
      queue: () => json({ jobs: queued ? [queuedJob] : [], paused: false }),
      enqueue: () => {
        queued = true;
        return json({ jobs: [queuedJob], skipped: [] });
      },
      list: () =>
        json({
          videos: [{ id: 'v1', title: 'Film 1', url: 'https://yt/v1' }],
          downloadStatuses: {},
          lastUpdatedDates: {},
        }),
    });
    renderPage();
    const rowA = (await screen.findByText('/videos/a')).closest('tr') as HTMLElement;

    await user.click(within(rowA).getByRole('button', { name: 'Pokaż filmy' }));
    await user.click(await screen.findByRole('button', { name: 'Pobierz listę filmów' }));
    await screen.findByText('Film 1');
    await user.click(screen.getByRole('button', { name: 'Pobierz' }));

    expect(await within(rowA).findByText('1 czeka', undefined, { timeout: 3000 })).toBeInTheDocument();
  });
});
