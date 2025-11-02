import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { act } from 'react';
import { useVideoDetail } from './useVideoDetail';

globalThis.fetch = vi.fn();

describe('useVideoDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset fetch mock
    (globalThis.fetch as any).mockClear();
  });

  it('should initialize with loading state', async () => {
    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ details: {} }),
    });

    const { result } = renderHook(() => useVideoDetail('test-video'));

    // Initially loading should be true
    await act(async () => {
      expect(result.current.state.loading).toBe(true);
      expect(result.current.state.error).toBeNull();
      expect(result.current.state.details).toBeNull();
    });
  });

  it('should fetch video details successfully', async () => {
    const mockDetails = {
      title: 'Test Video',
      description: 'Test description',
      uploadDate: '2024-01-01',
      duration: '10:30',
      viewCount: 1000,
      likeCount: 50,
      channel: 'Test Channel',
      comments: [],
      commentCount: 0,
      videoPath: 'test-video.mp4',
      thumbnailPath: 'test-video.webp',
    };

    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ details: mockDetails }),
    });

    const { result } = renderHook(() => useVideoDetail('test-video'));

    await waitFor(() => {
      expect(result.current.state.loading).toBe(false);
    });

    expect(result.current.state.details).toEqual(mockDetails);
    expect(result.current.state.error).toBeNull();
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/videos/test-video/details');
  });

  it('should handle undefined baseName', async () => {
    const { result } = renderHook(() => useVideoDetail(undefined));

    await waitFor(() => {
      expect(result.current.state.loading).toBe(false);
    });

    expect(result.current.state.error).toBe('Invalid video ID');
    expect(result.current.state.details).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('should handle empty string baseName', async () => {
    const { result } = renderHook(() => useVideoDetail(''));

    await waitFor(() => {
      expect(result.current.state.loading).toBe(false);
    });

    // Empty string is falsy, so it should trigger error
    expect(result.current.state.error).toBe('Invalid video ID');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('should handle fetch error', async () => {
    (globalThis.fetch as any).mockRejectedValueOnce(new Error('Network error'));

    const { result } = renderHook(() => useVideoDetail('test-video'));

    await waitFor(() => {
      expect(result.current.state.loading).toBe(false);
    });

    expect(result.current.state.error).toBe('Network error');
    expect(result.current.state.details).toBeNull();
  });

  it('should handle non-ok response', async () => {
    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: false,
      status: 404,
    });

    const { result } = renderHook(() => useVideoDetail('test-video'));

    await waitFor(() => {
      expect(result.current.state.loading).toBe(false);
    });

    expect(result.current.state.error).toBe('Failed to load video details');
    expect(result.current.state.details).toBeNull();
  });

  it('should handle non-Error exception', async () => {
    (globalThis.fetch as any).mockRejectedValueOnce('String error');

    const { result } = renderHook(() => useVideoDetail('test-video'));

    await waitFor(() => {
      expect(result.current.state.loading).toBe(false);
    });

    expect(result.current.state.error).toBe('An error occurred');
    expect(result.current.state.details).toBeNull();
  });

  it('should encode baseName in URL', async () => {
    const baseNameWithSpecialChars = 'video with spaces & special chars';

    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ details: {} }),
    });

    const { result } = renderHook(() => useVideoDetail(baseNameWithSpecialChars));

    await waitFor(() => {
      expect(result.current.state.loading).toBe(false);
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/videos/video%20with%20spaces%20%26%20special%20chars/details'
    );
  });

  it('should refetch when baseName changes', async () => {
    const mockDetails1 = {
      title: 'Video 1',
      description: 'Description 1',
      uploadDate: '2024-01-01',
      duration: '10:00',
      viewCount: 100,
      likeCount: 10,
      channel: 'Channel 1',
      comments: [],
      commentCount: 0,
      videoPath: 'video1.mp4',
      thumbnailPath: 'video1.webp',
    };

    const mockDetails2 = {
      title: 'Video 2',
      description: 'Description 2',
      uploadDate: '2024-01-02',
      duration: '20:00',
      viewCount: 200,
      likeCount: 20,
      channel: 'Channel 2',
      comments: [],
      commentCount: 0,
      videoPath: 'video2.mp4',
      thumbnailPath: 'video2.webp',
    };

    (globalThis.fetch as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ details: mockDetails1 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ details: mockDetails2 }),
      });

    const { result, rerender } = renderHook(
      (props: { baseName: string | undefined }) => useVideoDetail(props.baseName),
      {
        initialProps: { baseName: 'video1' } as { baseName: string | undefined },
      }
    );

    await waitFor(() => {
      expect(result.current.state.loading).toBe(false);
    });

    expect(result.current.state.details).toEqual(mockDetails1);

    await act(async () => {
      rerender({ baseName: 'video2' });
    });

    await waitFor(() => {
      expect(result.current.state.loading).toBe(false);
    });

    expect(result.current.state.details).toEqual(mockDetails2);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(globalThis.fetch).toHaveBeenNthCalledWith(1, '/api/videos/video1/details');
    expect(globalThis.fetch).toHaveBeenNthCalledWith(2, '/api/videos/video2/details');
  });

  it('should handle transition from undefined to valid baseName', async () => {
    const mockDetails = {
      title: 'Test Video',
      description: 'Test description',
      uploadDate: '2024-01-01',
      duration: '10:30',
      viewCount: 1000,
      likeCount: 50,
      channel: 'Test Channel',
      comments: [],
      commentCount: 0,
      videoPath: 'test-video.mp4',
      thumbnailPath: 'test-video.webp',
    };

    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ details: mockDetails }),
    });

    const { result, rerender } = renderHook(
      (props: { baseName: string | undefined }) => useVideoDetail(props.baseName),
      {
        initialProps: { baseName: undefined } as { baseName: string | undefined },
      }
    );

    await waitFor(() => {
      expect(result.current.state.error).toBe('Invalid video ID');
    });

    await act(async () => {
      rerender({ baseName: 'test-video' });
    });

    await waitFor(() => {
      expect(result.current.state.loading).toBe(false);
      expect(result.current.state.error).toBeNull();
    });

    expect(result.current.state.details).toEqual(mockDetails);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('should handle transition from valid baseName to undefined', async () => {
    const mockDetails = {
      title: 'Test Video',
      description: 'Test description',
      uploadDate: '2024-01-01',
      duration: '10:30',
      viewCount: 1000,
      likeCount: 50,
      channel: 'Test Channel',
      comments: [],
      commentCount: 0,
      videoPath: 'test-video.mp4',
      thumbnailPath: 'test-video.webp',
    };

    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ details: mockDetails }),
    });

    const { result, rerender } = renderHook(
      (props: { baseName: string | undefined }) => useVideoDetail(props.baseName),
      {
        initialProps: { baseName: 'test-video' } as { baseName: string | undefined },
      }
    );

    await waitFor(() => {
      expect(result.current.state.details).toEqual(mockDetails);
    });

    await act(async () => {
      rerender({ baseName: undefined });
    });

    await waitFor(() => {
      expect(result.current.state.error).toBe('Invalid video ID');
    });

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});

