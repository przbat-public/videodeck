import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { installFetchMock } from '../test/fetchMock';
import { act } from 'react';
import { useVideoDetail } from './useVideoDetail';

const fetchMock = installFetchMock();

describe('useVideoDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset fetch mock
    fetchMock.mockClear();
  });

  it('should initialize with loading state', async () => {
    fetchMock.mockResolvedValueOnce({
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
      channelName: 'Test Channel',
      comments: [],
      commentCount: 0,
      videoPath: 'test-video.mp4',
      thumbnailPath: 'test-video.webp',
      subtitles: [],
      folderPath: '/videos/a',
    };

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ details: mockDetails }),
    });

    const { result } = renderHook(() => useVideoDetail('test-video'));

    await waitFor(() => {
      expect(result.current.state.loading).toBe(false);
    });

    expect(result.current.state.details).toEqual(mockDetails);
    expect(result.current.state.error).toBeNull();
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/videos/test-video/details', {
      signal: expect.any(AbortSignal),
    });
  });

  it('should handle undefined baseName', async () => {
    const { result } = renderHook(() => useVideoDetail(undefined));

    await waitFor(() => {
      expect(result.current.state.loading).toBe(false);
    });

    expect(result.current.state.error).toBe('Nieprawidłowy identyfikator filmu');
    expect(result.current.state.details).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('should handle empty string baseName', async () => {
    const { result } = renderHook(() => useVideoDetail(''));

    await waitFor(() => {
      expect(result.current.state.loading).toBe(false);
    });

    // Empty string is falsy, so it should trigger error
    expect(result.current.state.error).toBe('Nieprawidłowy identyfikator filmu');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('should handle fetch error', async () => {
    fetchMock.mockRejectedValueOnce(new Error('Network error'));

    const { result } = renderHook(() => useVideoDetail('test-video'));

    await waitFor(() => {
      expect(result.current.state.loading).toBe(false);
    });

    expect(result.current.state.error).toBe('Network error');
    expect(result.current.state.details).toBeNull();
  });

  it('should handle non-ok response', async () => {
    fetchMock.mockResolvedValueOnce({
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
    fetchMock.mockRejectedValueOnce('String error');

    const { result } = renderHook(() => useVideoDetail('test-video'));

    await waitFor(() => {
      expect(result.current.state.loading).toBe(false);
    });

    expect(result.current.state.error).toBe('An error occurred');
    expect(result.current.state.details).toBeNull();
  });

  it('should encode baseName in URL', async () => {
    const baseNameWithSpecialChars = 'video with spaces & special chars';

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ details: {} }),
    });

    const { result } = renderHook(() => useVideoDetail(baseNameWithSpecialChars));

    await waitFor(() => {
      expect(result.current.state.loading).toBe(false);
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/videos/video%20with%20spaces%20%26%20special%20chars/details',
      { signal: expect.any(AbortSignal) }
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
      channelName: 'Channel 1',
      comments: [],
      commentCount: 0,
      videoPath: 'video1.mp4',
      thumbnailPath: 'video1.webp',
      subtitles: [],
      folderPath: '/videos/a',
    };

    const mockDetails2 = {
      title: 'Video 2',
      description: 'Description 2',
      uploadDate: '2024-01-02',
      duration: '20:00',
      viewCount: 200,
      likeCount: 20,
      channelName: 'Channel 2',
      comments: [],
      commentCount: 0,
      videoPath: 'video2.mp4',
      thumbnailPath: 'video2.webp',
      subtitles: [],
      folderPath: '/videos/a',
    };

    fetchMock
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
    expect(globalThis.fetch).toHaveBeenNthCalledWith(1, '/api/videos/video1/details', {
      signal: expect.any(AbortSignal),
    });
    expect(globalThis.fetch).toHaveBeenNthCalledWith(2, '/api/videos/video2/details', {
      signal: expect.any(AbortSignal),
    });
  });

  it('should handle transition from undefined to valid baseName', async () => {
    const mockDetails = {
      title: 'Test Video',
      description: 'Test description',
      uploadDate: '2024-01-01',
      duration: '10:30',
      viewCount: 1000,
      likeCount: 50,
      channelName: 'Test Channel',
      comments: [],
      commentCount: 0,
      videoPath: 'test-video.mp4',
      thumbnailPath: 'test-video.webp',
      subtitles: [],
      folderPath: '/videos/a',
    };

    fetchMock.mockResolvedValueOnce({
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
      expect(result.current.state.error).toBe('Nieprawidłowy identyfikator filmu');
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
      channelName: 'Test Channel',
      comments: [],
      commentCount: 0,
      videoPath: 'test-video.mp4',
      thumbnailPath: 'test-video.webp',
      subtitles: [],
      folderPath: '/videos/a',
    };

    fetchMock.mockResolvedValueOnce({
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
      expect(result.current.state.error).toBe('Nieprawidłowy identyfikator filmu');
    });

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});
