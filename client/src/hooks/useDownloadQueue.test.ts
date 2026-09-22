import { act, renderHook, waitFor } from '@testing-library/react';
import type { EnqueueJobsResponse, QueueJob } from '@videodeck/shared/api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FetchMock } from '../test/fetchMock';
import { installFetchMock } from '../test/fetchMock';
import { useDownloadQueue } from './useDownloadQueue';

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
    fetchMock.mockResolvedValue(jsonResponse({ paused: false, jobs: [makeJob({ status: 'done' })] }));

    const { result } = renderHook(() => useDownloadQueue(FOLDER));

    await waitFor(() => expect(result.current.jobs).toHaveLength(1));
    expect(fetchMock).toHaveBeenCalledWith(`/api/folder/queue?folderPath=${encodeURIComponent(FOLDER)}`, {
      cache: 'no-store',
      signal: expect.any(AbortSignal),
    });
    expect(result.current.hasActive).toBe(false);
    expect(result.current.jobsByVideoId.v1?.status).toBe('done');
  });

  it('exposes an error when the queue cannot be loaded', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, false, 500));

    const { result } = renderHook(() => useDownloadQueue(FOLDER));

    await waitFor(() => expect(result.current.error).toBe('Nie udało się wczytać kolejki'));
  });

  it('enqueues videos and refreshes the list', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ paused: false, jobs: [] })) // mount
      .mockResolvedValueOnce(jsonResponse({ paused: false, jobs: [makeJob({})], skipped: [] }, true, 202)) // POST
      .mockResolvedValueOnce(jsonResponse({ paused: false, jobs: [makeJob({ status: 'running' })] })); // refresh

    const { result } = renderHook(() => useDownloadQueue(FOLDER));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    let enqueueResult: EnqueueJobsResponse | undefined;
    await act(async () => {
      enqueueResult = await result.current.enqueue(
        [{ videoId: 'v1', videoUrl: 'https://www.youtube.com/watch?v=v1', title: 'One' }],
        'download',
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
    fetchMock.mockResolvedValue(jsonResponse({ paused: false, jobs: [] }));
    const { result } = renderHook(() => useDownloadQueue(FOLDER));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const enqueueResult = await result.current.enqueue([], 'download');

    expect(enqueueResult).toEqual({ jobs: [], skipped: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws the server error message when enqueue fails', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ paused: false, jobs: [] }))
      .mockResolvedValueOnce(jsonResponse({ error: 'Folder path is not in the allowed list' }, false, 403));

    const { result } = renderHook(() => useDownloadQueue(FOLDER));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await expect(result.current.enqueue([{ videoId: 'v1' }], 'download')).rejects.toThrow(
      'Folder path is not in the allowed list',
    );
  });

  it('polls while jobs are active and stops when they finish', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ paused: false, jobs: [makeJob({ status: 'running' })] }))
      .mockResolvedValueOnce(jsonResponse({ paused: false, jobs: [makeJob({ status: 'running', progress: 50 })] }))
      .mockResolvedValue(jsonResponse({ paused: false, jobs: [makeJob({ status: 'done' })] }));

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
    fetchMock.mockResolvedValueOnce(jsonResponse({ paused: false, jobs: [running] })).mockResolvedValue(
      jsonResponse({
        paused: false,
        jobs: [{ ...running, status: 'done', finishedAt: '2024-01-01T00:01:00.000Z' }],
      }),
    );

    renderHook(() => useDownloadQueue(FOLDER, { pollIntervalMs: 1000, onJobFinished, onQueueDrained }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(onJobFinished).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(onJobFinished).toHaveBeenCalledTimes(1);
    expect(onJobFinished).toHaveBeenCalledWith(expect.objectContaining({ id: 'job-1', status: 'done' }));
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
        paused: false,
        jobs: [
          makeJob({ id: 'old-error', status: 'error', createdAt: '2024-01-01T00:00:00.000Z' }),
          makeJob({ id: 'newer-done', status: 'done', createdAt: '2024-01-02T00:00:00.000Z' }),
          makeJob({ id: 'active', status: 'queued', createdAt: '2024-01-01T12:00:00.000Z' }),
          makeJob({ id: 'other', videoId: 'v2', status: 'done' }),
        ],
      }),
    );

    const { result } = renderHook(() => useDownloadQueue(FOLDER));

    await waitFor(() => expect(result.current.jobs).toHaveLength(4));
    expect(result.current.jobsByVideoId.v1?.id).toBe('active');
    expect(result.current.jobsByVideoId.v2?.id).toBe('other');
  });

  it('cancels a job and refreshes', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ paused: false, jobs: [makeJob({ status: 'running' })] }))
      .mockResolvedValueOnce(jsonResponse({ cancelled: true }))
      .mockResolvedValue(jsonResponse({ paused: false, jobs: [makeJob({ status: 'cancelled' })] }));

    const { result } = renderHook(() => useDownloadQueue(FOLDER));
    await waitFor(() => expect(result.current.hasActive).toBe(true));

    await act(async () => {
      await result.current.cancel('job-1');
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/folder/queue/job-1', { method: 'DELETE' });
    expect(result.current.hasActive).toBe(false);
  });

  it('cancelAll targets the folder', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ paused: false, jobs: [] }));
    const { result } = renderHook(() => useDownloadQueue(FOLDER));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      await result.current.cancelAll();
    });

    expect(fetchMock).toHaveBeenCalledWith(`/api/folder/queue?folderPath=${encodeURIComponent(FOLDER)}`, {
      method: 'DELETE',
    });
  });

  it('reports every change it made to the queue, after its own refresh', async () => {
    // The channel console polls the whole queue only while it sees something
    // active, so it has to be told when this hook queued or cancelled a job.
    const onQueueChanged = vi.fn();
    fetchMock.mockResolvedValue(jsonResponse({ paused: false, jobs: [], skipped: [] }));
    const { result } = renderHook(() => useDownloadQueue(FOLDER, { onQueueChanged }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(onQueueChanged).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.enqueue([{ videoId: 'v1' }], 'download');
    });
    expect(onQueueChanged).toHaveBeenCalledTimes(1);
    // POST, then the refresh GET, then the report: the caller reads a queue
    // this hook has already re-read.
    expect(fetchMock.mock.calls.length).toBe(3);

    await act(async () => {
      await result.current.cancel('job-1');
    });
    expect(onQueueChanged).toHaveBeenCalledTimes(2);

    await act(async () => {
      await result.current.cancelAll();
    });
    expect(onQueueChanged).toHaveBeenCalledTimes(3);

    // An empty enqueue never reached the server, so there is nothing to report
    await act(async () => {
      await result.current.enqueue([], 'download');
    });
    expect(onQueueChanged).toHaveBeenCalledTimes(3);
  });

  it('reloads when the folder changes', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ paused: false, jobs: [] }));
    const { rerender } = renderHook(({ folder }) => useDownloadQueue(folder), {
      initialProps: { folder: FOLDER },
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    rerender({ folder: '/videos/channel-b' });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenLastCalledWith(
      `/api/folder/queue?folderPath=${encodeURIComponent('/videos/channel-b')}`,
      { cache: 'no-store', signal: expect.any(AbortSignal) },
    );
  });
});
