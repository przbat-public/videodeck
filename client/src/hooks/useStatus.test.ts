import { act, renderHook, waitFor } from '@testing-library/react';
import type { StatusResponse } from '@videodeck/shared/api';
import { beforeEach, describe, expect, it } from 'vitest';
import type { MockResponse } from '../test/fetchMock';
import { installFetchMock, jsonResponse } from '../test/fetchMock';
import { useStatus } from './useStatus';

const fetchMock = installFetchMock();

const statusResponse: StatusResponse = {
  videosFolderPath: ['/videos/a', '/videos/b'],
  folderConfigs: {
    '/videos/a': { channelUrl: 'https://yt/@a' },
    '/videos/b': null,
  },
  downloadDefaults: { maxHeight: 2160, subLangs: ['en'], writeComments: true },
  indexedFolders: ['/videos/a'],
  listExists: { '/videos/a': true, '/videos/b': false },
  status: 'ok',
};

describe('useStatus', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(jsonResponse(statusResponse));
  });

  it('loads the status, flipping the loading flag along the way', async () => {
    const { result } = renderHook(() => useStatus());

    expect(result.current.state.loading).toBe(true);
    await waitFor(() => expect(result.current.state.loading).toBe(false));
    expect(result.current.state.statusData?.videosFolderPath).toEqual(['/videos/a', '/videos/b']);
    expect(result.current.state.error).toBeNull();
  });

  it('merges a freshly saved folder config into the loaded status', async () => {
    const { result } = renderHook(() => useStatus());
    await waitFor(() => expect(result.current.state.statusData).not.toBeNull());

    act(() => {
      result.current.updateFolderConfig('/videos/b', { channelUrl: 'https://yt/@b' });
    });

    expect(result.current.state.statusData?.folderConfigs['/videos/b']).toEqual({ channelUrl: 'https://yt/@b' });
  });

  it('ignores a config update while nothing is loaded yet', () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'boom' }, 500));
    const { result } = renderHook(() => useStatus());

    act(() => {
      result.current.updateFolderConfig('/videos/b', null);
    });

    expect(result.current.state.statusData).toBeNull();
  });

  it('swallows the abort from an unmounted fetch', async () => {
    let rejectFetch!: (err: Error) => void;
    fetchMock.mockImplementation(
      () =>
        new Promise<MockResponse>((_resolve, reject) => {
          rejectFetch = reject;
        }),
    );
    const { result, unmount } = renderHook(() => useStatus());
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    unmount();
    await act(async () => {
      rejectFetch(new Error('Aborted'));
    });

    // The aborted fetch dispatches nothing: no error state, no crash.
    expect(result.current.state.error).toBeNull();
  });

  it('loads the status again on reload after a failure', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'boom' }, 500));
    const { result } = renderHook(() => useStatus());
    await waitFor(() => expect(result.current.state.error).not.toBeNull());

    act(() => {
      result.current.reload();
    });

    await waitFor(() => expect(result.current.state.statusData).not.toBeNull());
    expect(result.current.state.error).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('falls back to the generic message when the failure is not an Error', async () => {
    fetchMock.mockRejectedValueOnce('boom');
    const { result } = renderHook(() => useStatus());

    await waitFor(() => expect(result.current.state.error).not.toBeNull());

    expect(result.current.state.error).toBe('Wystąpił błąd');
  });
});
