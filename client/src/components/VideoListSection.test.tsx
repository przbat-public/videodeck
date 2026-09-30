import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { QueueJob } from '@videodeck/shared/api';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n';
import type { FetchMock, MockResponse } from '../test/fetchMock';
import { toast } from '../test/toastMock';
import { isOlderThanMonth } from '../utils/videoDates';
import { VideoListSection } from './VideoListSection';

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

interface FetchHandlers {
  list?: () => unknown;
  queue?: () => unknown;
  enqueue?: (body: unknown) => unknown;
}

/** Response for the folder queue endpoints (GET/POST/DELETE share the prefix) */
function folderFetchResponse(url: string, init: RequestInit | undefined, handlers: FetchHandlers): MockResponse {
  if (url === LIST_URL) {
    return json(handlers.list?.() ?? listResponse);
  }
  if (url === QUEUE_URL && (init?.method || 'GET') === 'GET') {
    return json(handlers.queue?.() ?? { jobs: [], total: 0, paused: false });
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

/** Route fetch calls by URL/method so that tests can describe server state declaratively */
function installFetch(handlers: FetchHandlers): FetchMock {
  const fetchMock: FetchMock = vi.fn(
    async (url: string, init?: RequestInit): Promise<MockResponse> => folderFetchResponse(url, init, handlers),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

const postCalls = (fetchMock: FetchMock) =>
  fetchMock.mock.calls
    .filter(([url, init]) => url === '/api/folder/queue' && (init as RequestInit)?.method === 'POST')
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)));

/** Render the section for a channel whose list.json is already there */
function renderSection(listExists = true) {
  render(
    <MemoryRouter>
      <VideoListSection folderPath={FOLDER} listExists={listExists} />
    </MemoryRouter>,
  );
}

/** The section loads its own list: a loaded one is just its rendered count */
async function renderLoaded() {
  renderSection();
  await screen.findByText(/Liczba filmów: 4/);
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

/** The silenced reporter: a failed read is logged, and the test asserts that */
let errorLog: ReturnType<typeof vi.spyOn>;

describe('VideoListSection', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true, now });
    vi.clearAllMocks();
    errorLog = vi.spyOn(console, 'error').mockImplementation(() => {
      /* silence the expected error logs */
    });
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
      </MemoryRouter>,
    );
    expect(container.innerHTML).toBe('');
  });

  it('loads the channel list as soon as it opens, with no second click', async () => {
    const fetchMock = installFetch({});
    renderSection();

    // "Show videos" on the console is the same action as "load the list": the
    // rows arrive with the section instead of behind a button of their own.
    expect(await screen.findByText(/Liczba filmów: 4/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(LIST_URL);
  });

  it('loads videos on demand and summarises statuses', async () => {
    installFetch({});
    await renderLoaded();

    expect(screen.getByText(/1 nie pobrany/)).toBeInTheDocument();
    expect(screen.getByText(/1 nie zaktualizowany od ponad miesiąca/)).toBeInTheDocument();
    // The bulk actions live in the console row's menu now, so the section
    // carries the counts and the per-video buttons and nothing else
    expect(screen.queryByRole('button', { name: 'Pobierz wszystkie' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Aktualizuj wszystkie' })).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Pobierz' })).toHaveLength(2); // v3 + v4 (disabled)
  });

  it('reports a list that did not come back', async () => {
    const base = installFetch({});
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) =>
      url.startsWith('/api/folder/list') ? json({}, 500) : base(url, init),
    ) as unknown as typeof fetch;
    renderSection();

    expect(await screen.findByText(i18n.t('app.error', { message: i18n.t('errors.loadVideos') }))).toBeInTheDocument();
  });

  it('reports a failure that is not an Error at all', async () => {
    const base = installFetch({});
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/folder/list')) {
        // A rejected fetch can carry anything: the section must not assume
        // an Error and lose the message it has
        return Promise.reject('boom');
      }
      return base(url, init);
    }) as unknown as typeof fetch;
    renderSection();

    expect(await screen.findByText(i18n.t('app.error', { message: i18n.t('errors.occurred') }))).toBeInTheDocument();
  });

  it('asks for nothing while the folder has no list.json', () => {
    const fetchMock = installFetch({});
    renderSection(false);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('drops the rows of the channel it left when the console opens another one', async () => {
    const base = installFetch({});
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) =>
      url.includes('channel-b')
        ? json({
            videos: [{ id: 'b1', title: 'Drugi kanał', url: 'https://yt/b1' }],
            downloadStatuses: {},
            lastUpdatedDates: {},
          })
        : base(url, init),
    ) as unknown as typeof fetch;
    const view = render(
      <MemoryRouter>
        <VideoListSection folderPath={FOLDER} listExists={true} />
      </MemoryRouter>,
    );
    await screen.findByText(/Liczba filmów: 4/);

    view.rerender(
      <MemoryRouter>
        <VideoListSection folderPath="/videos/channel-b" listExists={true} />
      </MemoryRouter>,
    );

    // The rows of the previous channel are gone with its state, and the new
    // folder is what the section reads next
    expect(await screen.findByText(/Drugi kanał/)).toBeInTheDocument();
    expect(screen.queryByText(/Fresh/)).toBeNull();
    expect(screen.getByText(/Liczba filmów: 1/)).toBeInTheDocument();
  });

  it('re-reads its jobs when the page reports a queue change it did not make', async () => {
    let queueState: QueueJob[] = [];
    installFetch({
      queue: () => ({ jobs: queueState, total: queueState.length, paused: false }),
    });
    const view = render(
      <MemoryRouter>
        <VideoListSection folderPath={FOLDER} listExists={true} queueRevision={0} />
      </MemoryRouter>,
    );
    await screen.findByText(/Liczba filmów: 4/);

    // The console's row menu queued a job for this folder. The section's own
    // poll stopped when it last saw an idle queue, so the revision above is
    // the only thing that can tell it to look again.
    queueState = [makeJob({ status: 'queued' })];
    view.rerender(
      <MemoryRouter>
        <VideoListSection folderPath={FOLDER} listExists={true} queueRevision={1} />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Pobieranie: w kolejce')).toBeInTheDocument();
  });

  it('exposes the windowed rows as list items', async () => {
    installFetch({});
    await renderLoaded();

    // The list container is role="list"; dropping react-window's
    // ariaAttributes left it with no items at all.
    expect(screen.getByRole('list')).toBeInTheDocument();
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(4);
    expect(items[0]).toHaveAttribute('aria-posinset', '1');
    expect(items[0]).toHaveAttribute('aria-setsize', '4');
  });

  it('enqueues the download of one video from its own button', async () => {
    const fetchMock = installFetch({
      enqueue: () => ({ jobs: [makeJob({ status: 'queued' })], skipped: [] }),
    });
    await renderLoaded();

    // The video list owns one action per row now; the bulk ones moved to the
    // console row's menu, which works on the whole channel
    const enabledDownload = screen
      .getAllByRole('button', { name: 'Pobierz' })
      .find((button) => !(button as HTMLButtonElement).disabled);
    if (!enabledDownload) {
      throw new Error('Expected an enabled download button');
    }
    fireEvent.click(enabledDownload);

    await waitFor(() => expect(postCalls(fetchMock)).toHaveLength(1));
    expect(postCalls(fetchMock)[0]).toEqual({
      folderPath: FOLDER,
      type: 'download',
      videos: [{ videoId: 'v3' }],
    });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Dodano 1 film do pobrania'));
  });

  it('reports skipped videos from the server', async () => {
    installFetch({
      enqueue: () => ({ jobs: [], skipped: [{ videoId: 'v1', reason: 'not downloaded' }] }),
    });
    await renderLoaded();

    // v1 is on disk, so its own button is the update one
    fireEvent.click(screen.getAllByRole('button', { name: 'Aktualizuj' })[0] as HTMLButtonElement);

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Pominięto 1: not downloaded'));
  });

  it('shows a toast when the server rejects the enqueue', async () => {
    const fetchMock = installFetch({});
    fetchMock.mockImplementationOnce(async (url: string) =>
      json(url === LIST_URL ? listResponse : { jobs: [], total: 0, paused: false }),
    );
    await renderLoaded();
    fetchMock.mockImplementationOnce(async () => json({ error: 'Folder path is not in the allowed list' }, 403));

    const enabledDownload = screen
      .getAllByRole('button', { name: 'Pobierz' })
      .find((button) => !(button as HTMLButtonElement).disabled);
    if (!enabledDownload) {
      throw new Error('Expected an enabled download button');
    }
    fireEvent.click(enabledDownload);

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Folder path is not in the allowed list'));
  });

  it('shows queue state, marks finished downloads locally and re-syncs when the queue drains', async () => {
    let queueState: QueueJob[] = [makeJob({ status: 'running', progress: 10 })];
    let listState: ListResponse = listResponse;
    const fetchMock = installFetch({
      queue: () => ({ jobs: queueState, total: queueState.length, paused: false }),
      list: () => listState,
    });
    await renderLoaded();

    expect(screen.getByText(/kolejka: 1 w toku, 0 czeka/)).toBeInTheDocument();
    expect(screen.getByText('Pobieranie: 10%')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Anuluj' })).toBeInTheDocument();

    // job finishes on the server
    queueState = [makeJob({ status: 'done', finishedAt: '2024-06-15T11:30:00.000Z' })];
    listState = {
      ...listResponse,
      downloadStatuses: { ...listResponse.downloadStatuses, v3: true },
      lastUpdatedDates: { ...listResponse.lastUpdatedDates, v3: '2024-06-15T11:29:59.000Z' },
    };

    await waitFor(() => expect(screen.getByText('Pobrano')).toBeInTheDocument(), { timeout: 4000 });
    expect(screen.queryByText(/kolejka:/)).toBeNull();
    // v3 is now downloaded: its row offers an update instead of a download
    // and links to the detail page
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Pobierz' })).toHaveLength(1));
    expect(screen.getByRole('link', { name: /Missing/ })).toHaveAttribute('href', '/video/v3');

    // the list was re-fetched after the queue drained
    const listCalls = fetchMock.mock.calls.filter(([url]) => url === LIST_URL);
    await waitFor(() => expect(listCalls.length).toBeGreaterThanOrEqual(2));
  });

  it('keeps the rows when the list read after a drained queue fails', async () => {
    let queueState: QueueJob[] = [makeJob({ status: 'running' })];
    const base = installFetch({
      queue: () => ({ jobs: queueState, total: queueState.length, paused: false }),
    });
    await renderLoaded();

    // The queue drains while the list endpoint is down: the re-sync is the
    // section's own bookkeeping, so its failure leaves the rows untouched
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) =>
      url.startsWith('/api/folder/list') ? json({}, 500) : base(url, init),
    ) as unknown as typeof fetch;
    queueState = [];

    await waitFor(() => expect(errorLog).toHaveBeenCalled(), { timeout: 4000 });
    expect(screen.getByText(/Liczba filmów: 4/)).toBeInTheDocument();
    expect(screen.getByText(/Fresh/)).toBeInTheDocument();
  });

  it('cancels one job from its own row', async () => {
    const fetchMock = installFetch({
      queue: () => ({ jobs: [makeJob({ status: 'queued' })], total: 1, paused: false }),
    });
    await renderLoaded();

    fireEvent.click(await screen.findByRole('button', { name: 'Anuluj' }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(`/api/folder/queue/${encodeURIComponent('job-1')}`, { method: 'DELETE' }),
    );
  });

  it('keeps the row it failed to cancel on screen', async () => {
    const base = installFetch({
      queue: () => ({ jobs: [makeJob({ status: 'running', progress: 10 })], total: 1, paused: false }),
    });
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        throw new Error('network down');
      }
      return base(url, init);
    }) as unknown as typeof fetch;
    await renderLoaded();

    fireEvent.click(await screen.findByRole('button', { name: 'Anuluj' }));

    // A cancel that never reached the server must not empty the row: the
    // failure is logged and the job keeps its state
    await waitFor(() => expect(errorLog).toHaveBeenCalled());
    expect(screen.getByText('Pobieranie: 10%')).toBeInTheDocument();
  });
});
