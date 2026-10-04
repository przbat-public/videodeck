import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n';
import type { FetchMock, MockResponse } from '../test/fetchMock';
import { installFetchMock, jsonResponse } from '../test/fetchMock';
import type { VideoStateFilter } from '../utils/videoState';
import { useFolderState } from './useFolderState';

const fetchMock: FetchMock = installFetchMock();

const FOLDER = '/videos/kanal-a';
const STATE_URL = `/api/folder/state?folderPath=${encodeURIComponent(FOLDER)}&filter=all`;

const stateBody = (overrides: Record<string, unknown> = {}) => ({
  folderPath: FOLDER,
  videos: [
    {
      id: 'v1',
      title: 'Film pierwszy',
      url: 'https://youtu.be/v1',
      downloadState: {
        files: {
          video: true,
          thumbnail: true,
          description: false,
          subLangs: ['en'],
          comments: false,
          videoBytes: 1048576,
          infoBytes: 1024,
        },
        archive: { onDisk: true, inArchive: true, drift: false },
        missing: ['pl'],
      },
    },
  ],
  orphans: [],
  drift: { missingFromArchive: [], missingFromDisk: [] },
  counts: { videos: 1, downloaded: 1, incomplete: 1, notDownloaded: 0, orphans: 0 },
  ...overrides,
});

describe('useFolderState', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('reads the folder state and parses it with the shared schema', async () => {
    fetchMock.mockResolvedValue(jsonResponse(stateBody()));
    const { result } = renderHook(() => useFolderState(FOLDER));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(fetchMock.mock.calls[0]?.[0]).toBe(STATE_URL);
    expect(result.current.state?.counts.incomplete).toBe(1);
    expect(result.current.state?.videos[0]?.downloadState?.missing).toEqual(['pl']);
    expect(result.current.error).toBeNull();
  });

  it('asks the server for the filter the console has on', async () => {
    fetchMock.mockResolvedValue(jsonResponse(stateBody({ videos: [] })));
    const { result } = renderHook(() => useFolderState(FOLDER, { filter: 'incomplete' }));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `/api/folder/state?folderPath=${encodeURIComponent(FOLDER)}&filter=incomplete`,
    );
  });

  it('reads again when the filter changes', async () => {
    fetchMock.mockResolvedValue(jsonResponse(stateBody()));
    const { rerender } = renderHook(({ filter }: { filter: VideoStateFilter }) => useFolderState(FOLDER, { filter }), {
      initialProps: { filter: 'all' as VideoStateFilter },
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    rerender({ filter: 'orphan' });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1]?.[0]).toContain('filter=orphan');
  });

  it('drops the previous folder answer when another folder opens', async () => {
    fetchMock.mockResolvedValue(jsonResponse(stateBody()));
    const { result, rerender } = renderHook(({ folderPath }: { folderPath: string }) => useFolderState(folderPath), {
      initialProps: { folderPath: FOLDER },
    });
    await waitFor(() => expect(result.current.state).not.toBeNull());

    rerender({ folderPath: '/videos/kanal-b' });

    // The badges of the channel that was left must not hang over the new list
    expect(result.current.state).toBeNull();
  });

  it('re-reads on request, for the section that just drained its queue', async () => {
    fetchMock.mockResolvedValue(jsonResponse(stateBody()));
    const { result } = renderHook(() => useFolderState(FOLDER));
    await waitFor(() => expect(result.current.loading).toBe(false));

    result.current.refresh();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it('asks for nothing while it is disabled', () => {
    fetchMock.mockResolvedValue(jsonResponse(stateBody()));
    const { result } = renderHook(() => useFolderState(FOLDER, { enabled: false }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.state).toBeNull();
  });

  it('reports the message the server sent', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'folder not allowed' }, 403));
    const { result } = renderHook(() => useFolderState(FOLDER));

    await waitFor(() => expect(result.current.error).toBe('folder not allowed'));
    expect(result.current.state).toBeNull();
  });

  it('keeps nothing from a read that a closed section started', async () => {
    // The cleanup aborts the request, and an aborted read must not write its
    // answer into a hook nobody renders any more (nor clear its loading state,
    // which is what the aborted guard in the finally block is for).
    let release: ((response: MockResponse) => void) | undefined;
    fetchMock.mockImplementation(
      () =>
        new Promise<MockResponse>((resolve) => {
          release = resolve;
        }),
    );
    const { result, unmount } = renderHook(() => useFolderState(FOLDER));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    unmount();
    release?.(jsonResponse(stateBody()));
    await Promise.resolve();

    expect(result.current.state).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('reports an answer that does not match the contract without leaking the parse error', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ counts: 'nope' }));
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {
      /* the expected log of a failed read */
    });
    const { result } = renderHook(() => useFolderState(FOLDER));

    await waitFor(() => expect(result.current.error).toBe(i18n.t('videoState.loadError')));
    errorLog.mockRestore();
  });
});
