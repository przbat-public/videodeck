import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import toast from 'react-hot-toast';
import type { ReindexStatus } from '@shared/api';
import { useCacheRefresh, formatReindexProgress, formatReindexResult } from './useCacheRefresh';
import { installFetchMock } from '../test/fetchMock';
import type { MockResponse } from '../test/fetchMock';

const LOADING_TOAST_ID = 'loading-toast';

// The hook opens a loading toast, rewrites it with progress (same id) and
// finally replaces it with success/error
vi.mock('react-hot-toast', () => ({
  default: {
    loading: vi.fn(() => 'loading-toast'),
    success: vi.fn(),
    error: vi.fn(),
  },
}));

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

const withoutFolder = ({ currentFolder: _folder, ...status }: ReindexStatus): ReindexStatus =>
  status;

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
      'Reindexing · folder 1/2 · channel-a · 3/10 files · 3 indexed'
    );
  });

  it('omits parts that are not known yet', () => {
    expect(
      formatReindexProgress(withoutFolder(running({ foldersTotal: 0, filesTotal: 0, indexed: 0 })))
    ).toBe('Reindexing · 0 indexed');
  });
});

describe('formatReindexResult', () => {
  it('summarises a clean run', () => {
    expect(formatReindexResult(finished())).toBe('Reindex finished: 20 videos indexed');
  });

  it('mentions skipped files and folder errors', () => {
    expect(formatReindexResult(finished({ skipped: 2, errors: ['a', 'b'] }))).toBe(
      'Reindex finished: 20 videos indexed, 2 skipped, 2 folder errors'
    );
    expect(formatReindexResult(finished({ errors: ['a'] }))).toBe(
      'Reindex finished: 20 videos indexed, 1 folder error'
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
    mockServer(jsonResponse({ message: 'Cache refresh process started', status: 'ok' }), [
      jsonResponse(finished()),
    ]);

    const { result } = renderHook(() => useCacheRefresh());

    act(() => {
      result.current.refreshCache();
    });

    expect(result.current.loading).toBe(true);

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
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

    expect(fetchMock).toHaveBeenCalledWith(START_URL);
    expect(fetchMock).toHaveBeenCalledWith(STATUS_URL);
    expect(toast.loading).toHaveBeenCalledWith('Starting cache refresh process...');
    expect(toast.success).toHaveBeenCalledWith('Reindex finished: 2561 videos indexed, 2 skipped', {
      id: LOADING_TOAST_ID,
    });
    expect(toast.error).not.toHaveBeenCalled();
    expect(result.current.status).toEqual(finished({ indexed: 2561, skipped: 2 }));
  });

  it('polls the status and updates the loading toast until the run is over', async () => {
    vi.useFakeTimers();
    mockServer(jsonResponse({ status: 'ok' }), [
      jsonResponse(running()),
      jsonResponse(
        running({ foldersDone: 1, currentFolder: '/videos/channel-b', filesDone: 5, indexed: 15 })
      ),
      jsonResponse(finished()),
    ]);

    const { result } = renderHook(() => useCacheRefresh({ pollIntervalMs: 1000 }));

    let done: Promise<void>;
    act(() => {
      done = result.current.refreshCache();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(statusCalls()).toBe(1);
    expect(toast.loading).toHaveBeenLastCalledWith(
      'Reindexing · folder 1/2 · channel-a · 3/10 files · 3 indexed',
      { id: LOADING_TOAST_ID }
    );
    expect(result.current.loading).toBe(true);
    expect(result.current.status?.running).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(statusCalls()).toBe(2);
    expect(toast.loading).toHaveBeenLastCalledWith(
      'Reindexing · folder 2/2 · channel-b · 5/10 files · 15 indexed',
      { id: LOADING_TOAST_ID }
    );
    expect(toast.success).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      await done!;
    });
    expect(statusCalls()).toBe(3);
    expect(toast.success).toHaveBeenCalledWith('Reindex finished: 20 videos indexed', {
      id: LOADING_TOAST_ID,
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.status?.running).toBe(false);
  });

  it('follows an already running reindex on 409 instead of failing', async () => {
    mockServer(jsonResponse({ error: 'Reindex already running' }, 409), [jsonResponse(finished())]);

    const { result } = renderHook(() => useCacheRefresh());

    await act(async () => {
      await result.current.refreshCache();
    });

    expect(toast.loading).toHaveBeenCalledWith('A reindex is already running, following it...', {
      id: LOADING_TOAST_ID,
    });
    expect(toast.success).toHaveBeenCalledWith('Reindex finished: 20 videos indexed', {
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
        })
      ),
    ]);

    const { result } = renderHook(() => useCacheRefresh());

    await act(async () => {
      await result.current.refreshCache();
    });

    expect(toast.error).toHaveBeenCalledWith(
      'Reindex finished: 20 videos indexed, 1 folder error. Error scanning folder /videos/x: ENOENT',
      { id: LOADING_TOAST_ID }
    );
    expect(toast.success).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
  });

  it('should handle HTTP error response with custom message', async () => {
    mockServer(jsonResponse({ message: 'Service unavailable' }, 503), []);

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
      []
    );

    const { result } = renderHook(() => useCacheRefresh());

    await act(async () => {
      await result.current.refreshCache();
    });

    expect(toast.error).toHaveBeenCalledWith('Unknown error', { id: LOADING_TOAST_ID });
  });

  it('reports a failing status endpoint', async () => {
    mockServer(jsonResponse({ status: 'ok' }), [jsonResponse({}, 500)]);

    const { result } = renderHook(() => useCacheRefresh());

    await act(async () => {
      await result.current.refreshCache();
    });

    expect(toast.error).toHaveBeenCalledWith('Failed to read reindex status (HTTP 500)', {
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

    expect(toast.error).toHaveBeenCalledWith('Failed to start cache refresh', {
      id: LOADING_TOAST_ID,
    });
    expect(result.current.loading).toBe(false);
  });
});
