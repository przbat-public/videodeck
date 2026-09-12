import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { installFetchMock } from '../test/fetchMock';
import { act } from 'react';
import { useVideoSearch } from './useVideoSearch';

const fetchMock = installFetchMock();

describe('useVideoSearch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset fetch mock
    fetchMock.mockClear();
  });

  it('should initialize with empty videos', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ videos: [] }),
    });

    const { result } = renderHook(() => useVideoSearch());

    // Initially loading should be true because loadAll() is called in useEffect
    expect(result.current.loading).toBe(true);

    // Wait for loading to complete
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.videos).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it('should load all videos on mount', async () => {
    const mockVideos = [
      {
        baseName: 'test1',
        title: 'Test Video 1',
        description: 'Description 1',
        videoPath: 'test1.mp4',
        thumbnailPath: 'test1.webp',
        folderPath: '/test/videos',
      },
    ];

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ videos: mockVideos }),
    });

    const { result } = renderHook(() => useVideoSearch());

    await waitFor(() => {
      expect(result.current.videos).toEqual(mockVideos);
    });

    expect(globalThis.fetch).toHaveBeenCalledWith('/api/videos/search?sort=date-desc');
  });

  it('should search videos with query', async () => {
    const mockVideos = [
      {
        baseName: 'test1',
        title: 'Test Video 1',
        description: 'Test description',
        videoPath: 'test1.mp4',
        thumbnailPath: 'test1.webp',
        folderPath: '/test/videos',
      },
    ];

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ videos: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ videos: mockVideos }),
      });

    const { result } = renderHook(() => useVideoSearch());

    await waitFor(() => {
      expect(result.current.videos).toEqual([]);
    });

    await act(async () => {
      await result.current.search('test');
    });

    await waitFor(() => {
      expect(result.current.videos).toEqual(mockVideos);
    });

    expect(globalThis.fetch).toHaveBeenCalledWith('/api/videos/search?q=test&sort=date-desc');
  });

  it('should handle search error', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ videos: [] }),
      })
      .mockRejectedValueOnce(new Error('Network error'));

    const { result } = renderHook(() => useVideoSearch());

    await waitFor(() => {
      expect(result.current.videos).toEqual([]);
    });

    await act(async () => {
      await result.current.search('test');
    });

    await waitFor(() => {
      expect(result.current.error).toBe('Network error');
      expect(result.current.videos).toEqual([]);
    });
  });

  it('should handle non-ok response', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ videos: [] }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
      });

    const { result } = renderHook(() => useVideoSearch());

    await waitFor(() => {
      expect(result.current.videos).toEqual([]);
    });

    await act(async () => {
      await result.current.search('test');
    });

    await waitFor(() => {
      expect(result.current.error).toBe('Failed to search videos');
    });
  });

  it('should trim query before searching', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ videos: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ videos: [] }),
      });

    const { result } = renderHook(() => useVideoSearch());

    await waitFor(() => {
      expect(result.current.videos).toEqual([]);
    });

    await act(async () => {
      await result.current.search('  test  ');
    });

    expect(globalThis.fetch).toHaveBeenCalledWith('/api/videos/search?q=test&sort=date-desc');
  });

  it('should load all videos when query is empty', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ videos: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ videos: [] }),
      });

    const { result } = renderHook(() => useVideoSearch());

    await waitFor(() => {
      expect(result.current.videos).toEqual([]);
    });

    await act(async () => {
      await result.current.search('');
    });

    expect(globalThis.fetch).toHaveBeenCalledWith('/api/videos/search?sort=date-desc');
  });

  it('should load all videos when query is not provided', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ videos: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ videos: [] }),
      });

    const { result } = renderHook(() => useVideoSearch());

    await waitFor(() => {
      expect(result.current.videos).toEqual([]);
    });

    await act(async () => {
      await result.current.search();
    });

    expect(globalThis.fetch).toHaveBeenCalledWith('/api/videos/search?sort=date-desc');
  });

  it('should include sort parameter when searching', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ videos: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ videos: [] }),
      });

    const { result } = renderHook(() => useVideoSearch());

    await waitFor(() => {
      expect(result.current.videos).toEqual([]);
    });

    await act(async () => {
      await result.current.search('test', 'views-desc');
    });

    expect(globalThis.fetch).toHaveBeenCalledWith('/api/videos/search?q=test&sort=views-desc');
  });
});
