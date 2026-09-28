import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { installFetchMock, jsonResponse } from '../test/fetchMock';
import { libraryFrame } from '../test/libraryFrames';
import { applyLibraryFrame, applyLibraryRevision, resetLibraryState } from '../utils/libraryStatus';
import { useChannelNames } from './useChannelNames';

const fetchMock = installFetchMock();

describe('useChannelNames', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('loads the channel names and the folder map once on mount', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        channels: ['fpv channel', 'history channel'],
        folders: { '/videos/fpv': 'fpv channel' },
      }),
    );

    const { result } = renderHook(() => useChannelNames());

    expect(result.current.channels).toEqual([]);
    expect(result.current.folders).toEqual({});
    await waitFor(() => {
      expect(result.current.channels).toEqual(['fpv channel', 'history channel']);
    });
    expect(result.current.folders).toEqual({ '/videos/fpv': 'fpv channel' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/videos/channels', {
      signal: expect.any(AbortSignal),
    });
  });

  it('leaves the filter empty when the request fails', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'nope' }, 500));

    const { result } = renderHook(() => useChannelNames());

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(result.current.channels).toEqual([]);
    expect(result.current.folders).toEqual({});
  });

  it('does not set state after unmount', async () => {
    let resolveFetch!: (response: ReturnType<typeof jsonResponse>) => void;
    fetchMock.mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );

    const { result, unmount } = renderHook(() => useChannelNames());
    unmount();
    resolveFetch(jsonResponse({ channels: ['fpv channel'], folders: {} }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(result.current.channels).toEqual([]);
  });

  it('re-reads when the library revision moves', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ channels: ['fpv channel'], folders: {} }));
    renderHook(() => useChannelNames());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    act(() => {
      applyLibraryFrame(libraryFrame({ revision: 2, folders: ['/videos/a', '/videos/b'] }));
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it('waits for the first library value before it reads', async () => {
    // The channels come from the folders attached right now, so a read before
    // the first revision would answer a library that is already stale
    resetLibraryState();
    fetchMock.mockResolvedValue(jsonResponse({ channels: ['fpv channel'], folders: {} }));

    const { result } = renderHook(() => useChannelNames());

    expect(fetchMock).not.toHaveBeenCalled();

    act(() => {
      applyLibraryRevision(1);
    });

    await waitFor(() => expect(result.current.channels).toEqual(['fpv channel']));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
