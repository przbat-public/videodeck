import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { act } from 'react';
import { useVideoSearch } from './useVideoSearch';

globalThis.fetch = vi.fn();

describe('useVideoSearch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset fetch mock
    (globalThis.fetch as any).mockClear();
  });

  it('should initialize with empty videos', async () => {
    (globalThis.fetch as any).mockResolvedValueOnce({
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
        name: 'Test Video 1',
        description: 'Description 1',
        videoPath: 'test1.mp4',
        thumbnailPath: 'test1.webp',
      },
    ];

    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ videos: mockVideos }),
    });

    const { result } = renderHook(() => useVideoSearch());

    await waitFor(() => {
      expect(result.current.videos).toEqual(mockVideos);
    });

    expect(globalThis.fetch).toHaveBeenCalledWith('/api/videos/list');
  });

  it('should search videos with query', async () => {
    const mockVideos = [
      {
        baseName: 'test1',
        name: 'Test Video 1',
        description: 'Test description',
        videoPath: 'test1.mp4',
        thumbnailPath: 'test1.webp',
      },
    ];

    (globalThis.fetch as any)
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

    expect(globalThis.fetch).toHaveBeenCalledWith('/api/videos/search?q=test');
  });

  it('should handle search error', async () => {
    (globalThis.fetch as any)
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
    (globalThis.fetch as any)
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
    (globalThis.fetch as any)
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

    expect(globalThis.fetch).toHaveBeenCalledWith('/api/videos/search?q=test');
  });

  it('should handle empty query', async () => {
    (globalThis.fetch as any)
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

    expect(globalThis.fetch).toHaveBeenCalledWith('/api/videos/search?');
  });
});

