import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { act } from 'react';
import toast from 'react-hot-toast';
import type { VideoListItem } from '@shared/api';
import type { SearchState } from '../utils/searchUrlState';
import { installFetchMock, jsonResponse } from '../test/fetchMock';
import type { MockResponse } from '../test/fetchMock';
import { useVideoSearch } from './useVideoSearch';

vi.mock('react-hot-toast', () => ({
  default: { error: vi.fn(), success: vi.fn() },
}));

const fetchMock = installFetchMock();

const video = (baseName: string): VideoListItem => ({
  baseName,
  title: `Title ${baseName}`,
  description: 'Description',
  videoPath: `${baseName}.mp4`,
  thumbnailPath: `${baseName}.webp`,
  folderPath: '/videos',
  comments: [],
});

const state = (overrides: Partial<SearchState> = {}): SearchState => ({
  query: '',
  sort: 'date-desc',
  category: '',
  ...overrides,
});

/** A response the test resolves by hand, to control the order replies arrive in */
function deferred(): { promise: Promise<MockResponse>; resolve: (body: unknown) => void } {
  let resolve!: (body: unknown) => void;
  const promise = new Promise<MockResponse>((res) => {
    resolve = (body) => res(jsonResponse(body));
  });
  return { promise, resolve };
}

describe('useVideoSearch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockClear();
  });

  it('starts idle and fetches nothing until asked', () => {
    const { result } = renderHook(() => useVideoSearch());

    expect(result.current).toMatchObject({
      videos: [],
      totalCount: 0,
      loading: false,
      error: null,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe('request URL', () => {
    it.each<[string, SearchState, string]>([
      ['the defaults', state(), '/api/videos/search?sort=date-desc&offset=0&limit=100'],
      [
        'a query',
        state({ query: 'drone' }),
        '/api/videos/search?q=drone&sort=date-desc&offset=0&limit=100',
      ],
      [
        'a sort',
        state({ sort: 'views-desc' }),
        '/api/videos/search?sort=views-desc&offset=0&limit=100',
      ],
      [
        'a category',
        state({ category: 'fpv' }),
        '/api/videos/search?sort=date-desc&category=fpv&offset=0&limit=100',
      ],
      [
        'everything at once',
        state({ query: 'drone motor', sort: 'likes-asc', category: 'fpv' }),
        '/api/videos/search?q=drone+motor&sort=likes-asc&category=fpv&offset=0&limit=100',
      ],
      [
        'whitespace-padded values (trimmed)',
        state({ query: '  drone ', category: ' fpv ' }),
        '/api/videos/search?q=drone&sort=date-desc&category=fpv&offset=0&limit=100',
      ],
      [
        'whitespace-only values (dropped)',
        state({ query: '   ', category: '  ' }),
        '/api/videos/search?sort=date-desc&offset=0&limit=100',
      ],
    ])('encodes %s', async (_label, input, expectedUrl) => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ videos: [], totalCount: 0 }));
      const { result } = renderHook(() => useVideoSearch());

      await act(() => result.current.search(input));

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(expectedUrl);
    });
  });

  it('exposes the videos and the total, with loading toggled around the request', async () => {
    const reply = deferred();
    fetchMock.mockReturnValueOnce(reply.promise);
    const { result } = renderHook(() => useVideoSearch());

    let pending: Promise<void>;
    act(() => {
      pending = result.current.search(state({ query: 'drone' }));
    });
    expect(result.current.loading).toBe(true);

    reply.resolve({ videos: [video('a'), video('b')], totalCount: 42 });
    await act(() => pending);

    expect(result.current).toMatchObject({
      videos: [video('a'), video('b')],
      totalCount: 42,
      loading: false,
      error: null,
    });
  });

  it('tolerates a response without videos or a total', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    const { result } = renderHook(() => useVideoSearch());

    await act(() => result.current.search(state()));

    expect(result.current).toMatchObject({ videos: [], totalCount: 0, loading: false });
  });

  describe('loadMore', () => {
    it('appends the next page and reports hasMore while results remain', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ videos: [video('a')], totalCount: 3 }))
        .mockResolvedValueOnce(jsonResponse({ videos: [video('b')], totalCount: 3 }));
      const { result } = renderHook(() => useVideoSearch());

      await act(() => result.current.search(state()));
      expect(result.current.hasMore).toBe(true);

      await act(() => result.current.loadMore());

      expect(result.current.videos).toEqual([video('a'), video('b')]);
      expect(result.current.hasMore).toBe(true);
      expect(fetchMock).toHaveBeenLastCalledWith(
        '/api/videos/search?sort=date-desc&offset=1&limit=100'
      );
    });

    it('reports hasMore=false once everything is loaded', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ videos: [video('a')], totalCount: 1 }));
      const { result } = renderHook(() => useVideoSearch());

      await act(() => result.current.search(state()));

      expect(result.current.videos).toHaveLength(1);
      expect(result.current.hasMore).toBe(false);
    });

    it('continues the search that produced the current results', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ videos: [video('a')], totalCount: 2 }))
        .mockResolvedValueOnce(jsonResponse({ videos: [video('b')], totalCount: 2 }));
      const { result } = renderHook(() => useVideoSearch());

      await act(() => result.current.search(state({ query: 'drone', category: 'fpv' })));
      await act(() => result.current.loadMore());

      expect(fetchMock).toHaveBeenLastCalledWith(
        '/api/videos/search?q=drone&sort=date-desc&category=fpv&offset=1&limit=100'
      );
    });
  });

  it('reports a failed request and clears the previous results', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ videos: [video('a')], totalCount: 1 }))
      .mockRejectedValueOnce(new Error('Network error'));
    const { result } = renderHook(() => useVideoSearch());

    await act(() => result.current.search(state()));
    expect(result.current.videos).toHaveLength(1);

    await act(() => result.current.search(state({ query: 'drone' })));

    expect(result.current).toMatchObject({ videos: [], totalCount: 0, error: 'Network error' });
    expect(toast.error).toHaveBeenCalledWith('Failed to search videos: Network error');
  });

  it('treats a non-2xx response as a failure', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
    const { result } = renderHook(() => useVideoSearch());

    await act(() => result.current.search(state()));

    expect(result.current.error).toBe('Failed to search videos');
  });

  it('recovers from an error on the next successful search', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValueOnce(jsonResponse({ videos: [video('a')], totalCount: 1 }));
    const { result } = renderHook(() => useVideoSearch());

    await act(() => result.current.search(state()));
    await act(() => result.current.search(state()));

    expect(result.current).toMatchObject({ videos: [video('a')], totalCount: 1, error: null });
  });

  describe('overlapping searches', () => {
    it('lets only the newest search write the results, however late the older reply is', async () => {
      const first = deferred();
      const second = deferred();
      fetchMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
      const { result } = renderHook(() => useVideoSearch());

      let firstDone: Promise<void>;
      let secondDone: Promise<void>;
      act(() => {
        firstDone = result.current.search(state({ category: 'lego' }));
        secondDone = result.current.search(state({ category: 'fpv' }));
      });

      second.resolve({ videos: [video('fpv')], totalCount: 1 });
      await act(() => secondDone);
      expect(result.current).toMatchObject({
        videos: [video('fpv')],
        totalCount: 1,
        loading: false,
      });

      first.resolve({ videos: [video('lego-1'), video('lego-2')], totalCount: 2 });
      await act(() => firstDone);

      expect(result.current).toMatchObject({
        videos: [video('fpv')],
        totalCount: 1,
        loading: false,
      });
    });

    it('ignores a failure of a search that has already been superseded', async () => {
      fetchMock
        .mockRejectedValueOnce(new Error('slow one died'))
        .mockResolvedValueOnce(jsonResponse({ videos: [video('fresh')], totalCount: 1 }));
      const { result } = renderHook(() => useVideoSearch());

      await act(async () => {
        const stale = result.current.search(state({ query: 'old' }));
        const fresh = result.current.search(state({ query: 'new' }));
        await Promise.all([stale, fresh]);
      });

      expect(result.current).toMatchObject({ videos: [video('fresh')], error: null });
      expect(toast.error).not.toHaveBeenCalled();
    });

    it('keeps loading until the newest search settles, even after an older one has', async () => {
      const first = deferred();
      const second = deferred();
      fetchMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
      const { result } = renderHook(() => useVideoSearch());

      let firstDone: Promise<void>;
      act(() => {
        firstDone = result.current.search(state());
        void result.current.search(state({ sort: 'views-desc' }));
      });

      first.resolve({ videos: [video('old')], totalCount: 1 });
      await act(() => firstDone);

      expect(result.current.loading).toBe(true);
      expect(result.current.videos).toEqual([]);

      second.resolve({ videos: [video('new')], totalCount: 1 });
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.videos).toEqual([video('new')]);
    });
  });
});
