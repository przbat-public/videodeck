import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { QueueJob } from '@shared/api';
import { useDownloadQueue } from './useDownloadQueue';
import { installFetchMock } from '../test/fetchMock';
import type { FetchMock } from '../test/fetchMock';

const FOLDER = '/videos/channel-a';

const makeJob = (overrides: Partial<QueueJob>): QueueJob => ({
  id: 'job-1',
  folderPath: FOLDER,
  videoId: 'v1',
  videoUrl: 'https://www.youtube.com/watch?v=v1',
  type: 'download',
  status: 'queued',
  log: [],
  logLineCount: 0,
  createdAt: '2024-01-01T00:00:00.000Z',
  ...overrides,
});

const jsonResponse = (body: unknown, ok = true, status = 200) => ({
  ok,
  status,
  json: async () => body,
});

describe('useDownloadQueue', () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = installFetchMock();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('loads the queue for the folder on mount', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ jobs: [makeJob({ status: 'done' })] }));

    const { result } = renderHook(() => useDownloadQueue(FOLDER));

    await waitFor(() => expect(result.current.jobs).toHaveLength(1));
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/folder/queue?folderPath=${encodeURIComponent(FOLDER)}`,
      { signal: expect.any(AbortSignal) }
    );
    expect(result.current.hasActive).toBe(false);
    expect(result.current.jobsByVideoId.v1?.status).toBe('done');
  });

  it('exposes an error when the queue cannot be loaded', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, false, 500));

    const { result } = renderHook(() => useDownloadQueue(FOLDER));

    await waitFor(() => expect(result.current.error).toBe('Failed to load download queue'));
  });

  it('enqueues videos and refreshes the list', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ jobs: [] })) // mount
      .mockResolvedValueOnce(jsonResponse({ jobs: [makeJob({})], skipped: [] }, true, 202)) // POST
      .mockResolvedValueOnce(jsonResponse({ jobs: [makeJob({ status: 'running' })] })); // refresh

    const { result } = renderHook(() => useDownloadQueue(FOLDER));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    let enqueueResult;
    await act(async () => {
      enqueueResult = await result.current.enqueue(
        [{ videoId: 'v1', videoUrl: 'https://www.youtube.com/watch?v=v1', title: 'One' }],
        'download'
      );
    });

    expect(enqueueResult).toEqual({ jobs: [makeJob({})], skipped: [] });
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/folder/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        folderPath: FOLDER,
        type: 'download',
        videos: [{ videoId: 'v1', videoUrl: 'https://www.youtube.com/watch?v=v1', title: 'One' }],
      }),
    });
    expect(result.current.hasActive).toBe(true);
    expect(result.current.activeCount).toBe(1);
  });

  it('does not call the server when enqueueing an empty list', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ jobs: [] }));
    const { result } = renderHook(() => useDownloadQueue(FOLDER));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const enqueueResult = await result.current.enqueue([], 'download');

    expect(enqueueResult).toEqual({ jobs: [], skipped: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws the server error message when enqueue fails', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ jobs: [] }))
      .mockResolvedValueOnce(
        jsonResponse({ error: 'Folder path is not in the allowed list' }, false, 403)
      );

    const { result } = renderHook(() => useDownloadQueue(FOLDER));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await expect(result.current.enqueue([{ videoId: 'v1' }], 'download')).rejects.toThrow(
      'Folder path is not in the allowed list'
    );
  });

  it('polls while jobs are active and stops when they finish', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ jobs: [makeJob({ status: 'running' })] }))
      .mockResolvedValueOnce(jsonResponse({ jobs: [makeJob({ status: 'running', progress: 50 })] }))
      .mockResolvedValue(jsonResponse({ jobs: [makeJob({ status: 'done' })] }));

    const { result } = renderHook(() => useDownloadQueue(FOLDER, { pollIntervalMs: 1000 }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.hasActive).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.jobsByVideoId.v1?.progress).toBe(50);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.current.hasActive).toBe(false);

    // no more polling once idle
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('fires onJobFinished once per job and onQueueDrained when idle again', async () => {
    vi.useFakeTimers();
    const onJobFinished = vi.fn();
    const onQueueDrained = vi.fn();
    const running = makeJob({ status: 'running' });
    fetchMock.mockResolvedValueOnce(jsonResponse({ jobs: [running] })).mockResolvedValue(
      jsonResponse({
        jobs: [{ ...running, status: 'done', finishedAt: '2024-01-01T00:01:00.000Z' }],
      })
    );

    renderHook(() =>
      useDownloadQueue(FOLDER, { pollIntervalMs: 1000, onJobFinished, onQueueDrained })
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(onJobFinished).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(onJobFinished).toHaveBeenCalledTimes(1);
    expect(onJobFinished).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'job-1', status: 'done' })
    );
    expect(onQueueDrained).toHaveBeenCalledTimes(1);

    // a later refresh with the same finished job must not fire again
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(onJobFinished).toHaveBeenCalledTimes(1);
    expect(onQueueDrained).toHaveBeenCalledTimes(1);
  });

  it('prefers the active job per video, otherwise the newest one', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        jobs: [
          makeJob({ id: 'old-error', status: 'error', createdAt: '2024-01-01T00:00:00.000Z' }),
          makeJob({ id: 'newer-done', status: 'done', createdAt: '2024-01-02T00:00:00.000Z' }),
          makeJob({ id: 'active', status: 'queued', createdAt: '2024-01-01T12:00:00.000Z' }),
          makeJob({ id: 'other', videoId: 'v2', status: 'done' }),
        ],
      })
    );

    const { result } = renderHook(() => useDownloadQueue(FOLDER));

    await waitFor(() => expect(result.current.jobs).toHaveLength(4));
    expect(result.current.jobsByVideoId.v1?.id).toBe('active');
    expect(result.current.jobsByVideoId.v2?.id).toBe('other');
  });

  it('cancels a job and refreshes', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ jobs: [makeJob({ status: 'running' })] }))
      .mockResolvedValueOnce(jsonResponse({ cancelled: true }))
      .mockResolvedValue(jsonResponse({ jobs: [makeJob({ status: 'cancelled' })] }));

    const { result } = renderHook(() => useDownloadQueue(FOLDER));
    await waitFor(() => expect(result.current.hasActive).toBe(true));

    await act(async () => {
      await result.current.cancel('job-1');
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/folder/queue/job-1', { method: 'DELETE' });
    expect(result.current.hasActive).toBe(false);
  });

  it('cancelAll targets the folder', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ jobs: [] }));
    const { result } = renderHook(() => useDownloadQueue(FOLDER));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      await result.current.cancelAll();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/folder/queue?folderPath=${encodeURIComponent(FOLDER)}`,
      { method: 'DELETE' }
    );
  });

  it('reloads when the folder changes', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ jobs: [] }));
    const { rerender } = renderHook(({ folder }) => useDownloadQueue(folder), {
      initialProps: { folder: FOLDER },
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    rerender({ folder: '/videos/channel-b' });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenLastCalledWith(
      `/api/folder/queue?folderPath=${encodeURIComponent('/videos/channel-b')}`,
      { signal: expect.any(AbortSignal) }
    );
  });
});
