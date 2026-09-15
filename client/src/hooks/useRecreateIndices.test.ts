import { act, renderHook, waitFor } from '@testing-library/react';
import type { RecreateIndicesStatus } from '@videodeck/shared/api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockResponse } from '../test/fetchMock';
import { installFetchMock } from '../test/fetchMock';
import { toast } from '../test/toastMock';
import { RECREATE_POLL_INTERVAL_MS, useRecreateIndices } from './useRecreateIndices';

const LOADING_TOAST_ID = 'toast-id';

const fetchMock = installFetchMock();

const START_URL = '/api/videos/recreateIndices';
const STATUS_URL = '/api/videos/recreateIndices/status';

const finished = (overrides: Partial<RecreateIndicesStatus> = {}): RecreateIndicesStatus => ({
  running: false,
  foldersDone: 2,
  foldersTotal: 2,
  errors: [],
  ...overrides,
});

const running = (overrides: Partial<RecreateIndicesStatus> = {}): RecreateIndicesStatus => ({
  running: true,
  foldersDone: 0,
  foldersTotal: 2,
  errors: [],
  ...overrides,
});

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

describe('useRecreateIndices', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should initialize with loading false and no status', () => {
    const { result } = renderHook(() => useRecreateIndices());

    expect(result.current.loading).toBe(false);
    expect(result.current.status).toBeNull();
    expect(typeof result.current.recreateIndices).toBe('function');
  });

  it('posts to the endpoint and waits for the status before reporting done', async () => {
    mockServer(jsonResponse({ message: 'Indices recreation process started', status: 'ok' }), [
      jsonResponse(finished()),
    ]);

    const { result } = renderHook(() => useRecreateIndices());

    await act(async () => {
      await result.current.recreateIndices();
    });

    expect(fetchMock).toHaveBeenCalledWith(START_URL, { method: 'POST', signal: expect.any(AbortSignal) });
    expect(fetchMock).toHaveBeenCalledWith(STATUS_URL, { signal: expect.any(AbortSignal) });
    expect(toast.loading).toHaveBeenCalledWith('Rozpoczynanie odbudowy indeksów...');
    expect(toast.success).toHaveBeenCalledWith('Odbudowa indeksów zakończona', { id: LOADING_TOAST_ID });
    expect(toast.error).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
    expect(result.current.status?.running).toBe(false);
  });

  it('polls the status until the rebuild finishes instead of lying about it', async () => {
    vi.useFakeTimers();
    mockServer(jsonResponse({ status: 'ok' }), [
      jsonResponse(running()),
      jsonResponse(running({ foldersDone: 1 })),
      jsonResponse(finished()),
    ]);

    const { result } = renderHook(() => useRecreateIndices());

    let done: Promise<void> | undefined;
    act(() => {
      done = result.current.recreateIndices();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(statusCalls()).toBe(1);
    expect(result.current.loading).toBe(true);
    expect(result.current.status?.running).toBe(true);
    expect(toast.success).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(RECREATE_POLL_INTERVAL_MS);
    });
    expect(statusCalls()).toBe(2);
    expect(toast.success).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(RECREATE_POLL_INTERVAL_MS);
      await done;
    });
    expect(statusCalls()).toBe(3);
    expect(toast.success).toHaveBeenCalledWith('Odbudowa indeksów zakończona', { id: LOADING_TOAST_ID });
    expect(result.current.loading).toBe(false);
  });

  it('stops polling after unmount', async () => {
    vi.useFakeTimers();
    mockServer(jsonResponse({ status: 'ok' }), [jsonResponse(running()), jsonResponse(finished())]);

    const { result, unmount } = renderHook(() => useRecreateIndices());

    let done: Promise<void> | undefined;
    act(() => {
      done = result.current.recreateIndices();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(statusCalls()).toBe(1);

    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
      await done;
    });

    expect(statusCalls()).toBe(1);
  });

  it('follows an already running rebuild on 409 instead of failing', async () => {
    mockServer(jsonResponse({ error: 'Index recreation already running' }, 409), [jsonResponse(finished())]);

    const { result } = renderHook(() => useRecreateIndices());

    await act(async () => {
      await result.current.recreateIndices();
    });

    expect(toast.loading).toHaveBeenCalledWith('Odbudowa indeksów już trwa — czekam na jej zakończenie', {
      id: LOADING_TOAST_ID,
    });
    expect(toast.success).toHaveBeenCalledWith('Odbudowa indeksów zakończona', { id: LOADING_TOAST_ID });
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('reports a failed rebuild from the final status as an error toast', async () => {
    mockServer(jsonResponse({ status: 'ok' }), [
      jsonResponse(finished({ errors: ['Folder /videos/a: ES is down'], lastError: 'Folder /videos/a: ES is down' })),
    ]);

    const { result } = renderHook(() => useRecreateIndices());

    await act(async () => {
      await result.current.recreateIndices();
    });

    expect(toast.error).toHaveBeenCalledWith('Odbudowa indeksów nie powiodła się. Folder /videos/a: ES is down', {
      id: LOADING_TOAST_ID,
    });
    expect(toast.success).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
  });

  it('reports a failing status endpoint', async () => {
    mockServer(jsonResponse({ status: 'ok' }), [jsonResponse({}, 500)]);

    const { result } = renderHook(() => useRecreateIndices());

    await act(async () => {
      await result.current.recreateIndices();
    });

    expect(toast.error).toHaveBeenCalledWith('Nie udało się odczytać statusu odbudowy indeksów (HTTP 500)', {
      id: LOADING_TOAST_ID,
    });
    expect(result.current.loading).toBe(false);
  });

  it('handles an HTTP error from the start endpoint with its message', async () => {
    mockServer(jsonResponse({ message: 'Service unavailable' }, 503), []);

    const { result } = renderHook(() => useRecreateIndices());

    await act(async () => {
      await result.current.recreateIndices();
    });

    expect(toast.error).toHaveBeenCalledWith('Service unavailable', { id: LOADING_TOAST_ID });
    expect(statusCalls()).toBe(0);
    expect(result.current.loading).toBe(false);
  });

  it('falls back to the generic message on a network error', async () => {
    fetchMock.mockRejectedValueOnce(new Error('Network request failed'));

    const { result } = renderHook(() => useRecreateIndices());

    await act(async () => {
      await result.current.recreateIndices();
    });

    expect(toast.error).toHaveBeenCalledWith('Network request failed', { id: LOADING_TOAST_ID });
    expect(result.current.loading).toBe(false);
  });

  it('keeps loading true while the rebuild runs', async () => {
    mockServer(jsonResponse({ status: 'ok' }), [jsonResponse(running())]);

    const { result } = renderHook(() => useRecreateIndices());

    act(() => {
      result.current.recreateIndices();
    });

    await waitFor(() => {
      expect(result.current.status?.running).toBe(true);
    });
    expect(result.current.loading).toBe(true);
  });
});
