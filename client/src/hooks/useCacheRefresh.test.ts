import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReindexStatus } from '@videodeck/shared/api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockResponse } from '../test/fetchMock';
import { installFetchMock } from '../test/fetchMock';
import { toast } from '../test/toastMock';
import { formatReindexProgress, formatReindexResult, useCacheRefresh } from './useCacheRefresh';

const LOADING_TOAST_ID = 'toast-id';

const fetchMock = installFetchMock();

const START_URL = '/api/videos/refreshCache';
const STATUS_URL = '/api/videos/refreshCache/status';

const finished = (overrides: Partial<ReindexStatus> = {}): ReindexStatus => ({
  running: false,
  foldersDone: 2,
  foldersTotal: 2,
  filesDone: 10,
  filesTotal: 10,
  indexed: 20,
  skipped: 0,
  errors: [],
  ...overrides,
});

const running = (overrides: Partial<ReindexStatus> = {}): ReindexStatus => ({
  running: true,
  currentFolder: '/videos/channel-a',
  foldersDone: 0,
  foldersTotal: 2,
  filesDone: 3,
  filesTotal: 10,
  indexed: 3,
  skipped: 0,
  errors: [],
  ...overrides,
});

const withoutFolder = ({ currentFolder: _folder, ...status }: ReindexStatus): ReindexStatus => status;

const jsonResponse = (body: unknown, status = 200): MockResponse => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

/** Route fetch by URL; status responses are served in order, last one repeats */
function mockServer(startResponse: MockResponse, statuses: MockResponse[]) {
  const queue = [...statuses];
  fetchMock.mockImplementation(async (url) => {
    if (url === START_URL) return startResponse;
    if (url === STATUS_URL) {
      const next = queue.length > 1 ? queue.shift() : queue[0];
      if (next) return next;
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

const statusCalls = () => fetchMock.mock.calls.filter(([url]) => url === STATUS_URL).length;

describe('formatReindexProgress', () => {
  it('shows folder, file progress and indexed count', () => {
    expect(formatReindexProgress(running())).toBe(
      'Indeksowanie · folder 1/2 · channel-a · 3/10 plików · 3 zindeksowanych',
    );
  });

  it('omits parts that are not known yet', () => {
    expect(formatReindexProgress(withoutFolder(running({ foldersTotal: 0, filesTotal: 0, indexed: 0 })))).toBe(
      'Indeksowanie · 0 zindeksowanych',
    );
  });
});

describe('formatReindexResult', () => {
  it('summarises a clean run', () => {
    expect(formatReindexResult(finished())).toBe('Indeksowanie zakończone: 20 filmów zindeksowanych');
  });

  it('reports a skipped run (every folder already cached) specially', () => {
    expect(formatReindexResult(finished({ foldersTotal: 0, indexed: 0 }))).toBe(
      'Wszystkie foldery mają już indeks w Elasticsearch — nic do zrobienia',
    );
  });

  it('mentions skipped files and folder errors', () => {
    expect(formatReindexResult(finished({ skipped: 2, errors: ['a', 'b'] }))).toBe(
      'Indeksowanie zakończone: 20 filmów zindeksowanych, 2 pominiętych, 2 błędy folderów',
    );
    expect(formatReindexResult(finished({ errors: ['a'] }))).toBe(
      'Indeksowanie zakończone: 20 filmów zindeksowanych, 1 błąd folderu',
    );
  });
});

describe('useCacheRefresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should initialize with loading false and no status', () => {
    const { result } = renderHook(() => useCacheRefresh());

    expect(result.current.loading).toBe(false);
    expect(result.current.status).toBeNull();
    expect(typeof result.current.refreshCache).toBe('function');
  });

  it('should set loading to true while the reindex runs', async () => {
    mockServer(jsonResponse({ message: 'Cache refresh process started', status: 'ok' }), [jsonResponse(finished())]);

    const { result } = renderHook(() => useCacheRefresh());

    act(() => {
      result.current.refreshCache();
    });

    expect(result.current.loading).toBe(true);

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
  });

  it('asks the server to skip cached folders when onlyMissing is set', async () => {
    fetchMock.mockImplementation(async (url) => {
      if (url === '/api/videos/refreshCache?onlyMissing=1') {
        return jsonResponse({ message: 'Cache refresh process started', status: 'ok' });
      }
      if (url === STATUS_URL) {
        return jsonResponse(finished({ foldersTotal: 0, indexed: 0 }));
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const { result } = renderHook(() => useCacheRefresh());

    let done: Promise<void> | undefined;
    act(() => {
      done = result.current.refreshCache({ onlyMissing: true });
    });
    await act(async () => {
      await done;
    });

    const startCalls = fetchMock.mock.calls
      .map(([url]) => url)
      .filter((url) => url === START_URL || url === `${START_URL}?onlyMissing=1`);
    expect(startCalls).toEqual(['/api/videos/refreshCache?onlyMissing=1']);
    expect(toast.success).toHaveBeenCalledWith('Wszystkie foldery mają już indeks w Elasticsearch — nic do zrobienia', {
      id: LOADING_TOAST_ID,
    });
  });

  it('starts the reindex, reads the status and shows the summary', async () => {
    mockServer(jsonResponse({ message: 'Cache refresh process started', status: 'ok' }), [
      jsonResponse(finished({ indexed: 2561, skipped: 2 })),
    ]);

    const { result } = renderHook(() => useCacheRefresh());

    await act(async () => {
      await result.current.refreshCache();
    });

    expect(fetchMock).toHaveBeenCalledWith(START_URL, { method: 'POST', signal: expect.any(AbortSignal) });
    expect(fetchMock).toHaveBeenCalledWith(STATUS_URL, { signal: expect.any(AbortSignal) });
    expect(toast.loading).toHaveBeenCalledWith('Rozpoczynanie odświeżania indeksu...');
    expect(toast.success).toHaveBeenCalledWith('Indeksowanie zakończone: 2561 filmów zindeksowanych, 2 pominiętych', {
      id: LOADING_TOAST_ID,
    });
    expect(toast.error).not.toHaveBeenCalled();
    expect(result.current.status).toEqual(finished({ indexed: 2561, skipped: 2 }));
  });

  it('polls the status and updates the loading toast until the run is over', async () => {
    vi.useFakeTimers();
    mockServer(jsonResponse({ status: 'ok' }), [
      jsonResponse(running()),
      jsonResponse(running({ foldersDone: 1, currentFolder: '/videos/channel-b', filesDone: 5, indexed: 15 })),
      jsonResponse(finished()),
    ]);

    const { result } = renderHook(() => useCacheRefresh({ pollIntervalMs: 1000 }));

    let done: Promise<void> | undefined;
    act(() => {
      done = result.current.refreshCache();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(statusCalls()).toBe(1);
    expect(toast.loading).toHaveBeenLastCalledWith(
      'Indeksowanie · folder 1/2 · channel-a · 3/10 plików · 3 zindeksowanych',
      { id: LOADING_TOAST_ID },
    );
    expect(result.current.loading).toBe(true);
    expect(result.current.status?.running).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(statusCalls()).toBe(2);
    expect(toast.loading).toHaveBeenLastCalledWith(
      'Indeksowanie · folder 2/2 · channel-b · 5/10 plików · 15 zindeksowanych',
      { id: LOADING_TOAST_ID },
    );
    expect(toast.success).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      await done;
    });
    expect(statusCalls()).toBe(3);
    expect(toast.success).toHaveBeenCalledWith('Indeksowanie zakończone: 20 filmów zindeksowanych', {
      id: LOADING_TOAST_ID,
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.status?.running).toBe(false);
  });

  it('stops polling after unmount', async () => {
    vi.useFakeTimers();
    mockServer(jsonResponse({ status: 'ok' }), [jsonResponse(running()), jsonResponse(finished())]);

    const { result, unmount } = renderHook(() => useCacheRefresh({ pollIntervalMs: 1000 }));

    let done: Promise<void> | undefined;
    act(() => {
      done = result.current.refreshCache();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(statusCalls()).toBe(1);
    expect(result.current.status?.running).toBe(true);

    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
      await done;
    });

    // the loop noticed the abort after the sleep and never asked again
    expect(statusCalls()).toBe(1);
    vi.useRealTimers();
  });

  it('follows an already running reindex on 409 instead of failing', async () => {
    mockServer(jsonResponse({ error: 'Reindex already running' }, 409), [jsonResponse(finished())]);

    const { result } = renderHook(() => useCacheRefresh());

    await act(async () => {
      await result.current.refreshCache();
    });

    expect(toast.loading).toHaveBeenCalledWith('Indeksowanie już trwa — śledzę postęp...', {
      id: LOADING_TOAST_ID,
    });
    expect(toast.success).toHaveBeenCalledWith('Indeksowanie zakończone: 20 filmów zindeksowanych', {
      id: LOADING_TOAST_ID,
    });
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('reports folder errors from the final status as an error toast', async () => {
    mockServer(jsonResponse({ status: 'ok' }), [
      jsonResponse(
        finished({
          errors: ['Error scanning folder /videos/x: ENOENT'],
          lastError: 'Error scanning folder /videos/x: ENOENT',
        }),
      ),
    ]);

    const { result } = renderHook(() => useCacheRefresh());

    await act(async () => {
      await result.current.refreshCache();
    });

    expect(toast.error).toHaveBeenCalledWith(
      'Indeksowanie zakończone: 20 filmów zindeksowanych, 1 błąd folderu. Error scanning folder /videos/x: ENOENT',
      { id: LOADING_TOAST_ID },
    );
    expect(toast.success).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
  });

  it('should handle HTTP error response with custom message', async () => {
    // The API contract always carries `error`; `message` is the optional detail
    mockServer(jsonResponse({ error: 'Service unavailable' }, 503), []);

    const { result } = renderHook(() => useCacheRefresh());

    await act(async () => {
      await result.current.refreshCache();
    });

    expect(toast.error).toHaveBeenCalledWith('Service unavailable', { id: LOADING_TOAST_ID });
    expect(toast.success).not.toHaveBeenCalled();
    expect(statusCalls()).toBe(0);
    expect(result.current.loading).toBe(false);
  });

  it('should handle HTTP error response without message', async () => {
    mockServer(jsonResponse({}, 500), []);

    const { result } = renderHook(() => useCacheRefresh());

    await act(async () => {
      await result.current.refreshCache();
    });

    expect(toast.error).toHaveBeenCalledWith('HTTP error! status: 500', { id: LOADING_TOAST_ID });
  });

  it('should handle HTTP error when json parsing fails', async () => {
    mockServer(
      {
        ok: false,
        status: 500,
        json: async () => {
          throw new Error('JSON parse error');
        },
      },
      [],
    );

    const { result } = renderHook(() => useCacheRefresh());

    await act(async () => {
      await result.current.refreshCache();
    });

    expect(toast.error).toHaveBeenCalledWith('HTTP error! status: 500', { id: LOADING_TOAST_ID });
  });

  it('reports a failing status endpoint', async () => {
    mockServer(jsonResponse({ status: 'ok' }), [jsonResponse({}, 500)]);

    const { result } = renderHook(() => useCacheRefresh());

    await act(async () => {
      await result.current.refreshCache();
    });

    expect(toast.error).toHaveBeenCalledWith('Nie udało się odczytać statusu indeksowania (HTTP 500)', {
      id: LOADING_TOAST_ID,
    });
    expect(result.current.loading).toBe(false);
  });

  it('should handle network error', async () => {
    fetchMock.mockRejectedValueOnce(new Error('Network request failed'));

    const { result } = renderHook(() => useCacheRefresh());

    await act(async () => {
      await result.current.refreshCache();
    });

    expect(toast.error).toHaveBeenCalledWith('Network request failed', { id: LOADING_TOAST_ID });
    expect(toast.success).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
  });

  it('should handle unknown error type', async () => {
    fetchMock.mockRejectedValueOnce('Unknown error');

    const { result } = renderHook(() => useCacheRefresh());

    await act(async () => {
      await result.current.refreshCache();
    });

    expect(toast.error).toHaveBeenCalledWith('Nie udało się rozpocząć odświeżania indeksu', {
      id: LOADING_TOAST_ID,
    });
    expect(result.current.loading).toBe(false);
  });
});
