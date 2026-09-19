import { renderHook, waitFor } from '@testing-library/react';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockResponse } from '../test/fetchMock';
import { installFetchMock } from '../test/fetchMock';
import { useChannelQueue } from './useChannelQueue';

const fetchMock = installFetchMock();

const json = (body: unknown, status = 200): MockResponse => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const job = (id: string, folderPath: string, status: 'running' | 'queued' | 'done') => ({
  id,
  folderPath,
  videoId: id,
  videoUrl: `https://yt/${id}`,
  type: 'download' as const,
  status,
  log: [],
  logLineCount: 0,
  createdAt: '2026-09-19T10:00:00.000Z',
});

describe('useChannelQueue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockReset();
  });

  it('loads the whole queue and groups it by folder', async () => {
    fetchMock.mockResolvedValue(
      json({
        paused: false,
        jobs: [
          job('a', '/videos/kanal-a', 'running'),
          job('b', '/videos/kanal-a', 'done'),
          job('c', '/videos/kanal-b', 'queued'),
        ],
      }),
    );

    const { result } = renderHook(() => useChannelQueue());

    await waitFor(() => expect(result.current.jobs).toHaveLength(3));
    expect(fetchMock).toHaveBeenCalledWith('/api/folder/queue', {
      cache: 'no-store',
      signal: expect.any(AbortSignal),
    });
    expect(result.current.jobsByFolder['/videos/kanal-a']?.map((entry) => entry.id)).toEqual(['a', 'b']);
    expect(result.current.jobsByFolder['/videos/kanal-b']?.map((entry) => entry.id)).toEqual(['c']);
    expect(result.current.error).toBeNull();
  });

  it('reports a queue that cannot be loaded', async () => {
    fetchMock.mockResolvedValue(json({ error: 'boom' }, 500));

    const { result } = renderHook(() => useChannelQueue());

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.jobs).toEqual([]);
  });

  it('does not fetch while disabled', () => {
    fetchMock.mockResolvedValue(json({ paused: false, jobs: [] }));

    renderHook(() => useChannelQueue(false));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('polls while a job is active and stops when the queue drains', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      fetchMock.mockImplementation(() => {
        calls += 1;
        return Promise.resolve(
          json({ paused: false, jobs: [job('a', '/videos/kanal-a', calls === 1 ? 'running' : 'done')] }),
        );
      });

      const { result } = renderHook(() => useChannelQueue(true, 1000));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(calls).toBe(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(calls).toBe(2);
      expect(result.current.jobs[0]?.status).toBe('done');

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
