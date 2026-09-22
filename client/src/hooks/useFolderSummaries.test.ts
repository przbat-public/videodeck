import { renderHook, waitFor } from '@testing-library/react';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockResponse } from '../test/fetchMock';
import { installFetchMock } from '../test/fetchMock';
import { useFolderSummaries } from './useFolderSummaries';

const fetchMock = installFetchMock();

const json = (body: unknown, status = 200): MockResponse => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const body = {
  summaries: {
    '/videos/a': { videos: 10, downloaded: 8, notDownloaded: 2, stale: 1, newestUpdate: '2026-09-01T00:00:00.000Z' },
  },
};

describe('useFolderSummaries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockReset();
  });

  it('loads the counts for every channel', async () => {
    fetchMock.mockResolvedValue(json(body));
    const { result } = renderHook(() => useFolderSummaries());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.summaries['/videos/a']).toEqual(body.summaries['/videos/a']);
    expect(result.current.error).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith('/api/folder/summaries', { signal: expect.any(AbortSignal) });
  });

  it('reports a failed request and keeps the table usable', async () => {
    fetchMock.mockResolvedValue(json({ error: 'boom' }, 500));
    const { result } = renderHook(() => useFolderSummaries());

    await waitFor(() => expect(result.current.error).not.toBeNull());

    expect(result.current.summaries).toEqual({});
    expect(result.current.loading).toBe(false);
  });

  it('does not call the endpoint when disabled', () => {
    fetchMock.mockResolvedValue(json(body));
    const { result } = renderHook(() => useFolderSummaries(false));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
  });

  it('ignores a failure that lands after unmount', async () => {
    let rejectFetch!: (error: unknown) => void;
    fetchMock.mockImplementation(
      () =>
        new Promise<MockResponse>((_resolve, reject) => {
          rejectFetch = reject;
        }),
    );
    const { result, unmount } = renderHook(() => useFolderSummaries());
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    unmount();
    await act(async () => {
      rejectFetch(new Error('network'));
    });

    expect(result.current.error).toBeNull();
  });

  it('falls back to the generic message when the failure is not an Error', async () => {
    fetchMock.mockRejectedValue('boom');
    const { result } = renderHook(() => useFolderSummaries());

    await waitFor(() => expect(result.current.error).not.toBeNull());

    expect(result.current.error).toBe('Wystąpił błąd');
  });

  it('loads again on reload', async () => {
    fetchMock.mockResolvedValue(json(body));
    const { result } = renderHook(() => useFolderSummaries());
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.reload();
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it('refreshes the named folders alone and merges them into the counts', async () => {
    const fresh = { videos: 10, downloaded: 9, notDownloaded: 1, stale: 0, newestUpdate: '2026-09-21T00:00:00.000Z' };
    fetchMock.mockImplementation(async (url: string) =>
      url === '/api/folder/summaries'
        ? json({
            summaries: {
              ...body.summaries,
              '/videos/b': { videos: 4, downloaded: 4, notDownloaded: 0, stale: 0 },
            },
          })
        : json({ summaries: { '/videos/a': fresh } }),
    );
    const { result } = renderHook(() => useFolderSummaries());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.refreshFolders(['/videos/a']);
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/folder/summaries?folderPath=%2Fvideos%2Fa', { cache: 'no-store' });
    expect(result.current.summaries['/videos/a']).toEqual(fresh);
    // The other folder keeps the counts it had; the refresh replaces nothing else
    expect(result.current.summaries['/videos/b']).toEqual({ videos: 4, downloaded: 4, notDownloaded: 0, stale: 0 });
    expect(result.current.loading).toBe(false);
  });

  it('keeps the previous counts of a folder whose refresh fails', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url === '/api/folder/summaries' ? json(body) : json({ error: 'boom' }, 500),
    );
    const { result } = renderHook(() => useFolderSummaries());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.refreshFolders(['/videos/a']);
    });

    // A background refresh that fails is not an outage: the table keeps the
    // numbers it had and shows no banner
    expect(result.current.summaries['/videos/a']).toEqual(body.summaries['/videos/a']);
    expect(result.current.error).toBeNull();
  });
});
