import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { installFetchMock, jsonResponse } from '../test/fetchMock';
import { useChannelNames } from './useChannelNames';

const fetchMock = installFetchMock();

describe('useChannelNames', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('loads the channel names once on mount', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ channels: ['fpv channel', 'history channel'] }));

    const { result } = renderHook(() => useChannelNames());

    expect(result.current.channels).toEqual([]);
    await waitFor(() => {
      expect(result.current.channels).toEqual(['fpv channel', 'history channel']);
    });
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
    resolveFetch(jsonResponse({ channels: ['fpv channel'] }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(result.current.channels).toEqual([]);
  });
});
