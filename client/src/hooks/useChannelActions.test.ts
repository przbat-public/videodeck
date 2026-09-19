import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockResponse } from '../test/fetchMock';
import { installFetchMock, jsonResponse } from '../test/fetchMock';
import { toast } from '../test/toastMock';
import { useChannelActions } from './useChannelActions';

const fetchMock = installFetchMock();

const FOLDER = '/videos/kanal-a';

const listBody = (options: { downloaded?: Record<string, boolean>; lastUpdated?: Record<string, string> } = {}) => ({
  videos: [
    { id: 'a', title: 'Film a', url: 'https://youtu.be/a' },
    { id: 'b', title: 'Film b', url: 'https://youtu.be/b' },
    { id: 'c', title: 'Film c', url: 'https://youtu.be/c' },
  ],
  downloadStatuses: options.downloaded ?? {},
  lastUpdatedDates: options.lastUpdated ?? {},
});

const job = (videoId: string) => ({
  id: `job-${videoId}`,
  folderPath: FOLDER,
  videoId,
  videoUrl: `https://youtu.be/${videoId}`,
  type: 'download' as const,
  status: 'queued' as const,
  log: [],
  logLineCount: 0,
  createdAt: '2026-09-19T10:00:00.000Z',
});

/** Body of the nth fetch call, parsed */
const bodyOf = (index: number): unknown => JSON.parse(String(fetchMock.mock.calls[index]?.[1]?.body));

describe('useChannelActions', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.clearAllMocks();
  });

  it('enqueues the videos the channel is missing', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(listBody({ downloaded: { a: true } })))
      .mockResolvedValueOnce(jsonResponse({ jobs: [job('b'), job('c')], skipped: [] }));
    const onQueueChanged = vi.fn();
    const { result } = renderHook(() => useChannelActions({ onQueueChanged }));

    await act(async () => {
      await result.current.run(FOLDER, 'download');
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/folder/list?folderPath=%2Fvideos%2Fkanal-a');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/folder/queue');
    expect(bodyOf(1)).toEqual({
      folderPath: FOLDER,
      type: 'download',
      videos: [{ videoId: 'b' }, { videoId: 'c' }],
    });
    expect(toast.success).toHaveBeenCalledWith('Dodano 2 filmy do pobrania');
    expect(onQueueChanged).toHaveBeenCalledTimes(1);
    expect(result.current.pending[FOLDER]).toBeUndefined();
  });

  it('updates only the downloads that went stale', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(
          listBody({
            downloaded: { a: true, b: true },
            lastUpdated: {
              a: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
              b: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString(),
            },
          }),
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ jobs: [job('b')], skipped: [] }));
    const { result } = renderHook(() => useChannelActions({}));

    await act(async () => {
      await result.current.run(FOLDER, 'update-stale');
    });

    expect(bodyOf(1)).toEqual({ folderPath: FOLDER, type: 'update', videos: [{ videoId: 'b' }] });
    expect(toast.success).toHaveBeenCalledWith('Dodano 1 film do aktualizacji');
  });

  it('updates every downloaded video', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(listBody({ downloaded: { a: true, c: true } })))
      .mockResolvedValueOnce(jsonResponse({ jobs: [job('a'), job('c')], skipped: [] }));
    const { result } = renderHook(() => useChannelActions({}));

    await act(async () => {
      await result.current.run(FOLDER, 'update');
    });

    expect(bodyOf(1)).toEqual({
      folderPath: FOLDER,
      type: 'update',
      videos: [{ videoId: 'a' }, { videoId: 'c' }],
    });
  });

  it('reports the videos the server refused', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(listBody()))
      .mockResolvedValueOnce(jsonResponse({ jobs: [job('a')], skipped: [{ videoId: 'b', reason: 'already queued' }] }));
    const { result } = renderHook(() => useChannelActions({}));

    await act(async () => {
      await result.current.run(FOLDER, 'download');
    });

    expect(toast.error).toHaveBeenCalledWith('Pominięto 1: already queued');
  });

  it('does not queue anything when the channel has nothing to do', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(listBody({ downloaded: { a: true, b: true, c: true } })));
    const onQueueChanged = vi.fn();
    const { result } = renderHook(() => useChannelActions({ onQueueChanged }));

    await act(async () => {
      await result.current.run(FOLDER, 'download');
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith('Nie ma tu nic do zrobienia');
    expect(onQueueChanged).not.toHaveBeenCalled();
  });

  it('reports a failed enqueue with the server message', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(listBody()))
      .mockResolvedValueOnce(jsonResponse({ error: 'folder not allowed' }, 400));
    const onQueueChanged = vi.fn();
    const { result } = renderHook(() => useChannelActions({ onQueueChanged }));

    await act(async () => {
      await result.current.run(FOLDER, 'download');
    });

    expect(toast.error).toHaveBeenCalledWith('folder not allowed');
    expect(onQueueChanged).not.toHaveBeenCalled();
  });

  it('reports a video list that cannot be read', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'boom' }, 500));
    const { result } = renderHook(() => useChannelActions({}));

    await act(async () => {
      await result.current.run(FOLDER, 'download');
    });

    expect(toast.error).toHaveBeenCalledWith('Nie udało się wczytać listy filmów kanału');
    expect(result.current.pending[FOLDER]).toBeUndefined();
  });

  it('cancels every job the channel has in the queue', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ cancelled: 3 }));
    const onQueueChanged = vi.fn();
    const { result } = renderHook(() => useChannelActions({ onQueueChanged }));

    await act(async () => {
      await result.current.run(FOLDER, 'cancel');
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/folder/queue?folderPath=%2Fvideos%2Fkanal-a');
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('DELETE');
    expect(toast.success).toHaveBeenCalledWith('Anulowano zadania kanału');
    expect(onQueueChanged).toHaveBeenCalledTimes(1);
  });

  it('fetches the channel playlist and tells the page the list changed', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ output: 'ok' }));
    const onListChanged = vi.fn();
    const onQueueChanged = vi.fn();
    const { result } = renderHook(() => useChannelActions({ onListChanged, onQueueChanged }));

    await act(async () => {
      await result.current.run(FOLDER, 'playlist');
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/folder/download-playlist');
    expect(bodyOf(0)).toEqual({ folderPath: FOLDER });
    expect(toast.success).toHaveBeenCalledWith('Pobieram playlistę kanału');
    expect(onListChanged).toHaveBeenCalledTimes(1);
    expect(onQueueChanged).not.toHaveBeenCalled();
  });

  it('marks the folder busy until the action settles', async () => {
    let releaseList: ((value: MockResponse) => void) | undefined;
    const listInFlight = new Promise<MockResponse>((resolve) => {
      releaseList = resolve;
    });
    fetchMock.mockReturnValueOnce(listInFlight).mockResolvedValueOnce(jsonResponse({ jobs: [job('a')], skipped: [] }));
    const { result } = renderHook(() => useChannelActions({}));

    let running: Promise<void> | undefined;
    await act(async () => {
      running = result.current.run(FOLDER, 'download');
    });

    expect(result.current.pending[FOLDER]).toBe('download');

    await act(async () => {
      releaseList?.(jsonResponse(listBody()));
      await running;
    });

    expect(result.current.pending[FOLDER]).toBeUndefined();
  });

  it('reports a request that never answered', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    const onQueueChanged = vi.fn();
    const { result } = renderHook(() => useChannelActions({ onQueueChanged }));

    await act(async () => {
      await result.current.run(FOLDER, 'download');
    });

    expect(toast.error).toHaveBeenCalledWith('network down');
    expect(onQueueChanged).not.toHaveBeenCalled();
    expect(result.current.pending[FOLDER]).toBeUndefined();
  });

  it('reports a cancel the server refused', async () => {
    // No error field: the hook falls back to its own message
    fetchMock.mockResolvedValueOnce(jsonResponse({ refused: true }, 500));
    const onQueueChanged = vi.fn();
    const { result } = renderHook(() => useChannelActions({ onQueueChanged }));

    await act(async () => {
      await result.current.run(FOLDER, 'cancel');
    });

    expect(toast.error).toHaveBeenCalledWith('Nie udało się dodać do kolejki');
    expect(onQueueChanged).not.toHaveBeenCalled();
  });

  it('reports a playlist fetch that failed', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'no channelUrl' }, 400));
    const onListChanged = vi.fn();
    const { result } = renderHook(() => useChannelActions({ onListChanged }));

    await act(async () => {
      await result.current.run(FOLDER, 'playlist');
    });

    expect(toast.error).toHaveBeenCalledWith('no channelUrl');
    expect(onListChanged).not.toHaveBeenCalled();
  });
});
