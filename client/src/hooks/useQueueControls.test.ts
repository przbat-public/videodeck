import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockResponse } from '../test/fetchMock';
import { installFetchMock } from '../test/fetchMock';
import { useQueueControls } from './useQueueControls';

const fetchMock = installFetchMock();

const json = (body: unknown, status = 200): MockResponse => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const deferred = (): { promise: Promise<MockResponse>; resolve: (body: MockResponse) => void } => {
  let resolve!: (body: MockResponse) => void;
  const promise = new Promise<MockResponse>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

describe('useQueueControls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockReset();
  });

  it('ignores a stale initial refresh that resolves after a pause click', async () => {
    const initial = deferred();
    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/folder/queue') {
        return initial.promise;
      }
      if (url.startsWith('/api/folder/queue/pause')) {
        return Promise.resolve(json({ paused: true }));
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const { result } = renderHook(() => useQueueControls());

    await act(async () => {
      await result.current.setPaused(true);
    });
    expect(result.current.paused).toBe(true);

    // the mount fetch resolves late with a stale value
    await act(async () => {
      initial.resolve(json({ jobs: [], paused: false }));
      await initial.promise;
    });

    expect(result.current.paused).toBe(true); // must not flip back
  });

  it('surfaces a failed pause and stops the loading flag', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/folder/queue') {
        return Promise.resolve(json({ jobs: [], paused: false }));
      }
      if (url.startsWith('/api/folder/queue/pause')) {
        return Promise.resolve(json({ error: 'boom' }, 500));
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const { result } = renderHook(() => useQueueControls());
    await act(async () => {
      await expect(result.current.setPaused(true)).rejects.toThrow('Failed to pause queue (HTTP 500)');
    });

    expect(result.current.paused).toBe(false);
    expect(result.current.loading).toBe(false);
  });

  it('surfaces a failed clear and stops the loading flag', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/folder/queue') {
        return Promise.resolve(json({ jobs: [], paused: false }));
      }
      if (url === '/api/folder/queue/finished' && init?.method === 'DELETE') {
        return Promise.resolve(json({ error: 'boom' }, 500));
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const { result } = renderHook(() => useQueueControls());
    await act(async () => {
      await expect(result.current.clearFinished()).rejects.toThrow('Failed to clear finished jobs (HTTP 500)');
    });

    expect(result.current.loading).toBe(false);
  });
});
