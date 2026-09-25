import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockResponse } from '../test/fetchMock';
import { installFetchMock } from '../test/fetchMock';
import {
  QUEUE_SUMMARY_POLL_MS,
  refreshQueueSummary,
  resetQueueSummaryStore,
  useQueueSummary,
} from './queueSummaryStore';

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

describe('queueSummaryStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockReset();
    resetQueueSummaryStore();
  });

  it('serves two consumers from one poller', async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockResolvedValue(json(summary({ counts: { ...EMPTY_COUNTS, queued: 1 } })));

      const first = renderHook(() => useQueueSummary());
      const second = renderHook(() => useQueueSummary());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      // One read for both consumers, not one each
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(second.result.current.summary).toBe(first.result.current.summary);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(QUEUE_SUMMARY_POLL_MS);
        await vi.advanceTimersByTimeAsync(0);
      });

      // One poll for both consumers, not two
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops polling once the queue drains and the last consumer leaves', async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockResolvedValue(json(summary()));

      const { unmount } = renderHook(() => useQueueSummary());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Nothing is queued or running: the poll does not start at all
      await act(async () => {
        await vi.advanceTimersByTimeAsync(QUEUE_SUMMARY_POLL_MS * 4);
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);

      unmount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      await refreshQueueSummary();
      // No consumer left: an explicit refresh still answers, nothing polls
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the last answer when a read fails and clears the error on the next one', async () => {
    fetchMock.mockResolvedValueOnce(json(summary({ counts: { ...EMPTY_COUNTS, done: 3 } }))); // mount read
    fetchMock.mockRejectedValueOnce(new Error('Network error')); // the poll that fails
    fetchMock.mockResolvedValueOnce(json(summary({ counts: { ...EMPTY_COUNTS, done: 4 } }))); // recovery

    const { result } = renderHook(() => useQueueSummary());
    await act(async () => {
      await vi.waitFor(() => expect(result.current.summary).not.toBeNull());
    });
    expect(result.current.summary?.counts.done).toBe(3);

    await act(async () => {
      await refreshQueueSummary();
    });
    expect(result.current.error).toBe('Network error');
    expect(result.current.summary?.counts.done).toBe(3);

    await act(async () => {
      await refreshQueueSummary();
    });
    expect(result.current.error).toBeNull();
    expect(result.current.summary?.counts.done).toBe(4);
  });

  it('reports a summary that cannot be read', async () => {
    fetchMock.mockResolvedValue(json({ error: 'boom' }, 500));

    const { result } = renderHook(() => useQueueSummary());

    await act(async () => {
      await refreshQueueSummary();
    });
    expect(result.current.error).toBe('Nie udało się wczytać kolejki');
    expect(result.current.summary).toBeNull();
  });

  it('does not fetch for a consumer that is disabled', () => {
    renderHook(() => useQueueSummary(false));

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
