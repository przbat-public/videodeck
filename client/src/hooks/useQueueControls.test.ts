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
      await result.current.setPaused(true);
    });

    // The hook reports the failure instead of rejecting into a `void`ed
    // promise handler nobody could catch.
    expect(result.current.error).toBe('Nie udało się wstrzymać kolejki (HTTP 500)');
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
      await result.current.clearFinished();
    });

    expect(result.current.error).toBe('Nie udało się wyczyścić zakończonych zadań (HTTP 500)');
    expect(result.current.loading).toBe(false);
  });

  it('reports a failed read instead of leaving the controls silently stale', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/folder/queue') {
        return Promise.reject(new Error('Network error'));
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const { result } = renderHook(() => useQueueControls());
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.error).toBe('Network error');
  });

  it('falls back to the generic message when the failure is not an Error', async () => {
    fetchMock.mockImplementation((url: string) =>
      url === '/api/folder/queue' ? Promise.reject('boom') : Promise.reject(new Error(url)),
    );

    const { result } = renderHook(() => useQueueControls());
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.error).toBe('Wystąpił błąd');
  });

  it('re-reads the queue when the tab regains focus', async () => {
    fetchMock.mockImplementation((url: string) =>
      url === '/api/folder/queue' ? Promise.resolve(json({ jobs: [], paused: false })) : Promise.reject(new Error(url)),
    );
    renderHook(() => useQueueControls());
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Coming back to the tab should not wait out the poll interval.
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('ignores a read that fails after unmount', async () => {
    let rejectFetch!: (error: unknown) => void;
    fetchMock.mockImplementation(
      () =>
        new Promise<MockResponse>((_resolve, reject) => {
          rejectFetch = reject;
        }),
    );
    const { result, unmount } = renderHook(() => useQueueControls());
    await act(async () => {
      await Promise.resolve();
    });

    unmount();
    await act(async () => {
      rejectFetch(new Error('Network error'));
    });

    // The request belonged to an unmounted page: no error, no crash.
    expect(result.current.error).toBeNull();
  });

  it('picks up a job that finished elsewhere without a reload', async () => {
    vi.useFakeTimers();
    try {
      let reads = 0;
      const doneJob = {
        id: 'job-1',
        folderPath: '/videos/a',
        videoId: 'v1',
        videoUrl: 'https://yt/v1',
        type: 'download',
        status: 'done',
        log: [],
        logLineCount: 0,
        createdAt: '2026-01-01T10:00:00.000Z',
        finishedAt: '2026-01-01T10:01:00.000Z',
      };
      fetchMock.mockImplementation((url: string) => {
        if (url === '/api/folder/queue') {
          reads += 1;
          return Promise.resolve(json({ jobs: reads > 1 ? [doneJob] : [], paused: false }));
        }
        throw new Error(`unexpected fetch ${url}`);
      });

      const { result } = renderHook(() => useQueueControls());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.finishedCount).toBe(0);

      // The mount read saw an empty queue; the poll has to notice the job the
      // list page finished in the meantime.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4000);
      });

      expect(result.current.finishedCount).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
