import { renderHook } from '@testing-library/react';
import type { DownloadState } from '@videodeck/shared/api';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n';
import type { MockResponse } from '../test/fetchMock';
import { installFetchMock, jsonResponse } from '../test/fetchMock';
import { toast } from '../test/toastMock';
import { useChannelActions } from './useChannelActions';

const fetchMock = installFetchMock();

const FOLDER = '/videos/kanal-a';

/** A video on disk, complete unless the test says otherwise */
const onDisk = (overrides: Partial<DownloadState> = {}): DownloadState => ({
  files: {
    video: true,
    thumbnail: true,
    description: true,
    subLangs: ['en'],
    comments: true,
    videoBytes: 1048576,
    infoBytes: 2048,
  },
  archive: { onDisk: true, inArchive: true, drift: false },
  missing: [],
  ...overrides,
});

/** A video of the catalog that was never downloaded */
const absent: DownloadState = {
  files: null,
  archive: { onDisk: false, inArchive: false, drift: false },
  missing: [],
};

/** `GET /api/folder/state?filter=incomplete` for the videos the test names */
const stateBody = (videos: Array<{ id: string; downloadState: DownloadState }>) => ({
  folderPath: FOLDER,
  videos: videos.map((video) => ({ ...video, title: `Film ${video.id}`, url: `https://youtu.be/${video.id}` })),
  orphans: [],
  drift: { missingFromArchive: [], missingFromDisk: [] },
  counts: { videos: videos.length, downloaded: 0, incomplete: 0, notDownloaded: 0, orphans: 0 },
});

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

  it('translates the reason the queue refused a video', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(listBody()))
      .mockResolvedValueOnce(jsonResponse({ jobs: [], skipped: [{ videoId: 'b', reason: 'members-only' }] }, 202));
    const { result } = renderHook(() => useChannelActions({}));

    await act(async () => {
      await result.current.run(FOLDER, 'download');
    });

    expect(toast.error).toHaveBeenCalledWith(
      i18n.t('toast.skipped', { count: 1, reason: i18n.t('errors.job.members-only') }),
    );
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

  it('repairs the gaps of the videos that are on disk', async () => {
    // The server answers with every row, not only the incomplete ones: the
    // selection below is what decides who gets a repair job.
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(
          stateBody([
            { id: 'a', downloadState: onDisk() },
            { id: 'b', downloadState: onDisk({ missing: ['pl'] }) },
            { id: 'c', downloadState: absent },
          ]),
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ jobs: [job('b')], skipped: [] }, 202));
    const onQueueChanged = vi.fn();
    const { result } = renderHook(() => useChannelActions({ onQueueChanged }));

    await act(async () => {
      await result.current.run(FOLDER, 'repair');
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/folder/state?folderPath=%2Fvideos%2Fkanal-a&filter=incomplete`);
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/folder/repair');
    expect(bodyOf(1)).toEqual({
      folderPath: FOLDER,
      method: 'sidecars',
      videos: [{ videoId: 'b' }],
    });
    expect(toast.success).toHaveBeenCalledWith(i18n.t('toast.repairQueued', { count: 1 }));
    expect(onQueueChanged).toHaveBeenCalledTimes(1);
  });

  it('never sends a video the folder has not downloaded for repair', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(stateBody([{ id: 'c', downloadState: absent }])));
    const onQueueChanged = vi.fn();
    const { result } = renderHook(() => useChannelActions({ onQueueChanged }));

    await act(async () => {
      await result.current.run(FOLDER, 'repair');
    });

    // A repair runs with --skip-download: nothing to repair means no request
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith(i18n.t('channelConsole.actions.nothingToDo'));
    expect(onQueueChanged).not.toHaveBeenCalled();
  });

  it('refreshes the comments when that is the repair asked for', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(stateBody([{ id: 'b', downloadState: onDisk({ missing: ['pl'] }) }])))
      .mockResolvedValueOnce(jsonResponse({ jobs: [job('b')], skipped: [] }, 202));
    const { result } = renderHook(() => useChannelActions({}));

    await act(async () => {
      await result.current.run(FOLDER, 'repair-comments');
    });

    expect(bodyOf(1)).toEqual({ folderPath: FOLDER, method: 'comments', videos: [{ videoId: 'b' }] });
    expect(toast.success).toHaveBeenCalledWith(i18n.t('toast.commentsQueued', { count: 1 }));
  });

  it('reconciles the archive from the disk and says what changed', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        added: ['a', 'b'],
        removed: ['c'],
        unchanged: 4,
        drift: { missingFromArchive: [], missingFromDisk: [] },
      }),
    );
    const onQueueChanged = vi.fn();
    const { result } = renderHook(() => useChannelActions({ onQueueChanged }));

    await act(async () => {
      await result.current.run(FOLDER, 'reconcile');
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/folder/archive/reconcile');
    expect(bodyOf(0)).toEqual({ folderPath: FOLDER, method: 'rebuild' });
    expect(toast.success).toHaveBeenCalledWith(i18n.t('toast.archiveReconciled', { added: 2, removed: 1 }));
    expect(onQueueChanged).toHaveBeenCalledTimes(1);
  });

  it('reports a repair the server refused', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(stateBody([{ id: 'b', downloadState: onDisk({ missing: ['pl'] }) }])))
      .mockResolvedValueOnce(jsonResponse({ error: 'videos must be a non-empty array' }, 400));
    const onQueueChanged = vi.fn();
    const { result } = renderHook(() => useChannelActions({ onQueueChanged }));

    await act(async () => {
      await result.current.run(FOLDER, 'repair');
    });

    expect(toast.error).toHaveBeenCalledWith('videos must be a non-empty array');
    expect(onQueueChanged).not.toHaveBeenCalled();
  });

  it('falls back to its own wording when the server sends no message', async () => {
    // A failure body carries `error` and often no `message` (`ApiErrorSchema`
    // makes it optional). The toast then has to say something a reader can act
    // on rather than rendering "undefined".
    fetchMock
      .mockResolvedValueOnce(jsonResponse(stateBody([{ id: 'b', downloadState: onDisk({ missing: ['pl'] }) }])))
      // A gateway that answers with a body the contract cannot parse: no
      // `error`, no `message`, nothing to show a reader
      .mockResolvedValueOnce({ ok: false, status: 502, json: async () => ({ html: '<html>bad gateway</html>' }) });
    const { result } = renderHook(() => useChannelActions({}));

    await act(async () => {
      await result.current.run(FOLDER, 'repair');
    });

    expect(toast.error).toHaveBeenCalledWith(i18n.t('toast.enqueueFailed'));
  });
});
