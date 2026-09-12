import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import toast from 'react-hot-toast';
import { VideoListSection } from './VideoListSection';
import { isOlderThanMonth } from '../utils/videoDates';
import type { QueueJob } from '@shared/api';
import type { FetchMock, MockResponse } from '../test/fetchMock';

vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

const FOLDER = '/videos/channel-a';
const QUEUE_URL = `/api/folder/queue?folderPath=${encodeURIComponent(FOLDER)}`;
const LIST_URL = `/api/folder/list?folderPath=${encodeURIComponent(FOLDER)}`;

const now = new Date('2024-06-15T12:00:00.000Z');
const recent = '2024-06-10T00:00:00.000Z';
const old = '2024-01-01T00:00:00.000Z';

interface ListResponse {
  videos: Array<{ id: string; title: string; url: string }>;
  downloadStatuses: Record<string, boolean>;
  lastUpdatedDates: Record<string, string>;
}

const listResponse: ListResponse = {
  videos: [
    { id: 'v1', title: 'Fresh', url: 'https://www.youtube.com/watch?v=v1' },
    { id: 'v2', title: 'Stale', url: 'https://www.youtube.com/watch?v=v2' },
    { id: 'v3', title: 'Missing', url: 'https://www.youtube.com/watch?v=v3' },
    { id: 'v4', title: 'No url', url: '' },
  ],
  downloadStatuses: { v1: true, v2: true },
  lastUpdatedDates: { v1: recent, v2: old },
};

const makeJob = (overrides: Partial<QueueJob>): QueueJob => ({
  id: 'job-1',
  folderPath: FOLDER,
  videoId: 'v3',
  videoUrl: 'https://www.youtube.com/watch?v=v3',
  type: 'download',
  status: 'running',
  log: [],
  logLineCount: 0,
  createdAt: '2024-06-15T11:00:00.000Z',
  ...overrides,
});

const json = (body: unknown, status = 200): MockResponse => ({
  ok: status < 400,
  status,
  json: async () => body,
});

/** Route fetch calls by URL/method so that tests can describe server state declaratively */
function installFetch(handlers: {
  list?: () => unknown;
  queue?: () => unknown;
  enqueue?: (body: unknown) => unknown;
}): FetchMock {
  const fetchMock: FetchMock = vi.fn(
    async (url: string, init?: RequestInit): Promise<MockResponse> => {
      if (url === LIST_URL) return json(handlers.list?.() ?? listResponse);
      if (url === QUEUE_URL && (!init || !init.method || init.method === 'GET')) {
        return json(handlers.queue?.() ?? { jobs: [] });
      }
      if (url === '/api/folder/queue' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        return json(handlers.enqueue?.(body) ?? { jobs: [], skipped: [] }, 202);
      }
      if (url.startsWith('/api/folder/queue') && init?.method === 'DELETE') {
        return json({ cancelled: true });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    }
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

const postCalls = (fetchMock: FetchMock) =>
  fetchMock.mock.calls
    .filter(
      ([url, init]) => url === '/api/folder/queue' && (init as RequestInit)?.method === 'POST'
    )
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)));

async function renderLoaded() {
  const ref = { current: null as null | { loadVideos: () => Promise<void> } };
  render(
    <MemoryRouter>
      <VideoListSection ref={ref} folderPath={FOLDER} listExists={true} />
    </MemoryRouter>
  );
  await act(async () => {
    await ref.current!.loadVideos();
  });
  await screen.findByText(/Liczba filmów: 4/);
  return ref;
}

describe('isOlderThanMonth', () => {
  it('treats missing or invalid dates as old', () => {
    expect(isOlderThanMonth(undefined, now.getTime())).toBe(true);
    expect(isOlderThanMonth('garbage', now.getTime())).toBe(true);
  });

  it('compares against a 30 day window', () => {
    expect(isOlderThanMonth(recent, now.getTime())).toBe(false);
    expect(isOlderThanMonth(old, now.getTime())).toBe(true);
  });
});

describe('VideoListSection', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true, now });
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('renders nothing when list.json does not exist', () => {
    installFetch({});
    const { container } = render(
      <MemoryRouter>
        <VideoListSection folderPath={FOLDER} listExists={false} />
      </MemoryRouter>
    );
    expect(container.innerHTML).toBe('');
  });

  it('loads videos on demand and summarises statuses', async () => {
    installFetch({});
    await renderLoaded();

    expect(screen.getByText(/1 nie pobranych/)).toBeInTheDocument();
    expect(screen.getByText(/1 nie zaktualizowanych od ponad miesiąca/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pobierz wszystkie' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Aktualizuj stare' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Pobierz' })).toHaveLength(2); // v3 + v4 (disabled)
  });

  it('"Pobierz wszystkie" enqueues only videos that are not downloaded and have a url', async () => {
    const fetchMock = installFetch({
      enqueue: () => ({ jobs: [makeJob({ status: 'queued' })], skipped: [] }),
    });
    await renderLoaded();

    fireEvent.click(screen.getByRole('button', { name: 'Pobierz wszystkie' }));

    await waitFor(() => expect(postCalls(fetchMock)).toHaveLength(1));
    expect(postCalls(fetchMock)[0]).toEqual({
      folderPath: FOLDER,
      type: 'download',
      videos: [{ videoId: 'v3' }],
    });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Dodano 1 filmów do pobrania'));
  });

  it('"Aktualizuj" enqueues update jobs for downloaded videos older than a month', async () => {
    const fetchMock = installFetch({
      enqueue: () => ({
        jobs: [makeJob({ videoId: 'v2', type: 'update', status: 'queued' })],
        skipped: [],
      }),
    });
    await renderLoaded();

    fireEvent.click(screen.getByRole('button', { name: 'Aktualizuj stare' }));

    await waitFor(() => expect(postCalls(fetchMock)).toHaveLength(1));
    expect(postCalls(fetchMock)[0]).toEqual({
      folderPath: FOLDER,
      type: 'update',
      videos: [{ videoId: 'v2' }],
    });
  });

  it('a single item button enqueues just that video', async () => {
    const fetchMock = installFetch({});
    await renderLoaded();

    const enabledDownload = screen
      .getAllByRole('button', { name: 'Pobierz' })
      .find((button) => !(button as HTMLButtonElement).disabled)!;
    fireEvent.click(enabledDownload);

    await waitFor(() => expect(postCalls(fetchMock)).toHaveLength(1));
    expect(postCalls(fetchMock)[0].videos).toEqual([{ videoId: 'v3' }]);
  });

  it('reports skipped videos from the server', async () => {
    installFetch({
      enqueue: () => ({ jobs: [], skipped: [{ videoId: 'v2', reason: 'not downloaded' }] }),
    });
    await renderLoaded();

    fireEvent.click(screen.getByRole('button', { name: 'Aktualizuj stare' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Pominięto 1: not downloaded'));
  });

  it('shows a toast when the server rejects the enqueue', async () => {
    const fetchMock = installFetch({});
    fetchMock.mockImplementationOnce(async (url: string) =>
      json(url === LIST_URL ? listResponse : { jobs: [] })
    );
    await renderLoaded();
    fetchMock.mockImplementationOnce(async () =>
      json({ error: 'Folder path is not in the allowed list' }, 403)
    );

    fireEvent.click(screen.getByRole('button', { name: 'Pobierz wszystkie' }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Folder path is not in the allowed list')
    );
  });

  it('shows queue state, marks finished downloads locally and re-syncs when the queue drains', async () => {
    let queueState: QueueJob[] = [makeJob({ status: 'running', progress: 10 })];
    let listState: ListResponse = listResponse;
    const fetchMock = installFetch({ queue: () => ({ jobs: queueState }), list: () => listState });
    await renderLoaded();

    expect(screen.getByText(/kolejka: 1 w toku, 0 czeka/)).toBeInTheDocument();
    expect(screen.getByText('Pobieranie: 10%')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Anuluj wszystko' })).toBeInTheDocument();

    // job finishes on the server
    queueState = [makeJob({ status: 'done', finishedAt: '2024-06-15T11:30:00.000Z' })];
    listState = {
      ...listResponse,
      downloadStatuses: { ...listResponse.downloadStatuses, v3: true },
      lastUpdatedDates: { ...listResponse.lastUpdatedDates, v3: '2024-06-15T11:29:59.000Z' },
    };

    await waitFor(() => expect(screen.getByText('Pobrano')).toBeInTheDocument(), { timeout: 4000 });
    expect(screen.queryByText(/kolejka:/)).toBeNull();
    // v3 is now downloaded: "Pobierz wszystkie" disappears and the item links to the detail page
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Pobierz wszystkie' })).toBeNull()
    );
    expect(screen.getByRole('link', { name: /Missing/ })).toHaveAttribute('href', '/video/v3');

    // the list was re-fetched after the queue drained
    const listCalls = fetchMock.mock.calls.filter(([url]) => url === LIST_URL);
    await waitFor(() => expect(listCalls.length).toBeGreaterThanOrEqual(2));
  });

  it('"Anuluj wszystko" cancels the folder queue', async () => {
    const fetchMock = installFetch({ queue: () => ({ jobs: [makeJob({ status: 'queued' })] }) });
    await renderLoaded();

    fireEvent.click(await screen.findByRole('button', { name: 'Anuluj wszystko' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(QUEUE_URL, { method: 'DELETE' }));
  });
});
