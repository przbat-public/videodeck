import { renderHook, waitFor } from '@testing-library/react';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockResponse } from '../test/fetchMock';
import { installFetchMock } from '../test/fetchMock';
import { resetQueueSummaryStore } from '../utils/queueSummaryStore';
import { useChannelQueue } from './useChannelQueue';

const fetchMock = installFetchMock();

const json = (body: unknown, status = 200): MockResponse => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const EMPTY_COUNTS = { queued: 0, running: 0, done: 0, error: 0, cancelled: 0 };

const summary = (overrides: Record<string, unknown> = {}) => ({
  paused: false,
  counts: EMPTY_COUNTS,
  folders: {},
  running: [],
  ...overrides,
});

describe('useChannelQueue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockReset();
    resetQueueSummaryStore();
  });

  it('loads the queue counters and exposes them per folder', async () => {
    fetchMock.mockResolvedValue(
      json(
        summary({
          counts: { queued: 1, running: 1, done: 1, error: 0, cancelled: 0 },
          folders: {
            '/videos/kanal-a': { running: 1, queued: 0, failed: 0 },
            '/videos/kanal-b': { running: 0, queued: 1, failed: 0 },
          },
        }),
      ),
    );

    const { result } = renderHook(() => useChannelQueue());

    await waitFor(() => expect(result.current.queueByFolder['/videos/kanal-a']?.running).toBe(1));
    expect(fetchMock).toHaveBeenCalledWith('/api/folder/queue/summaries', {
      cache: 'no-store',
      signal: expect.any(AbortSignal),
    });
    expect(result.current.queueByFolder['/videos/kanal-b']).toEqual({ running: 0, queued: 1, failed: 0 });
    expect(result.current.counts.done).toBe(1);
    expect(result.current.error).toBeNull();
  });

  it('reports a queue summary that cannot be loaded', async () => {
    fetchMock.mockResolvedValue(json({ error: 'boom' }, 500));

    const { result } = renderHook(() => useChannelQueue());

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.queueByFolder).toEqual({});
    expect(result.current.counts).toEqual(EMPTY_COUNTS);
  });

  it('does not fetch while disabled', () => {
    fetchMock.mockResolvedValue(json(summary()));

    renderHook(() => useChannelQueue(false));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ignores a failure that lands after unmount', async () => {
    let rejectFetch!: (error: unknown) => void;
    fetchMock.mockImplementation(
      () =>
        new Promise<MockResponse>((_resolve, reject) => {
          rejectFetch = reject;
        }),
    );
    const { result, unmount } = renderHook(() => useChannelQueue());
    await act(async () => {
      await Promise.resolve();
    });

    unmount();
    await act(async () => {
      rejectFetch(new Error('network'));
    });

    expect(result.current.error).toBeNull();
  });

  it('polls while a job is active and stops when the queue drains', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      fetchMock.mockImplementation(() => {
        calls += 1;
        return Promise.resolve(
          json(summary({ counts: { ...EMPTY_COUNTS, queued: calls === 1 ? 2 : 0, done: calls === 1 ? 0 : 2 } })),
        );
      });

      const { result } = renderHook(() => useChannelQueue());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(calls).toBe(1);
      expect(result.current.counts.queued).toBe(2);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1500);
        // The poll is a promise chain: let it settle inside act, or React
        // reports the store update as an update outside act
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(calls).toBe(2);
      expect(result.current.counts.done).toBe(2);

      // Nothing is active any more, so the interval is gone
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
