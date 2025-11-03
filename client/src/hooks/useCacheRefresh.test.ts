import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { act } from 'react';
import toast from 'react-hot-toast';
import { useCacheRefresh } from './useCacheRefresh';

// Mock react-hot-toast
vi.mock('react-hot-toast', () => ({
  default: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

globalThis.fetch = vi.fn();

describe('useCacheRefresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (globalThis.fetch as any).mockClear();
    (toast.success as any).mockClear();
    (toast.error as any).mockClear();
  });

  it('should initialize with loading false', () => {
    const { result } = renderHook(() => useCacheRefresh());

    expect(result.current.loading).toBe(false);
    expect(typeof result.current.refreshCache).toBe('function');
  });

  it('should set loading to true when refreshCache is called', async () => {
    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ message: 'Cache refresh process started', status: 'ok' }),
    });

    const { result } = renderHook(() => useCacheRefresh());

    expect(result.current.loading).toBe(false);

    act(() => {
      result.current.refreshCache();
    });

    // Should be loading immediately after calling refreshCache
    expect(result.current.loading).toBe(true);

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
  });

  it('should call refreshCache endpoint and show success toast', async () => {
    const mockResponse = {
      message: 'Cache refresh process started',
      status: 'ok',
    };

    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    });

    const { result } = renderHook(() => useCacheRefresh());

    await act(async () => {
      await result.current.refreshCache();
    });

    expect(globalThis.fetch).toHaveBeenCalledWith('/api/videos/refreshCache');
    expect(toast.success).toHaveBeenCalledWith(mockResponse.message);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('should show default success message when response has no message', async () => {
    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'ok' }),
    });

    const { result } = renderHook(() => useCacheRefresh());

    await act(async () => {
      await result.current.refreshCache();
    });

    expect(toast.success).toHaveBeenCalledWith('Cache refresh process started successfully!');
  });

  it('should handle HTTP error response with custom message', async () => {
    const errorMessage = 'Service unavailable';

    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: async () => ({ message: errorMessage }),
    });

    const { result } = renderHook(() => useCacheRefresh());

    await act(async () => {
      await result.current.refreshCache();
    });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(toast.error).toHaveBeenCalledWith(errorMessage);
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('should handle HTTP error response without message', async () => {
    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({}),
    });

    const { result } = renderHook(() => useCacheRefresh());

    await act(async () => {
      await result.current.refreshCache();
    });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(toast.error).toHaveBeenCalledWith('HTTP error! status: 500');
  });

  it('should handle HTTP error when json parsing fails', async () => {
    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error('JSON parse error');
      },
    });

    const { result } = renderHook(() => useCacheRefresh());

    await act(async () => {
      await result.current.refreshCache();
    });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(toast.error).toHaveBeenCalledWith('Unknown error');
  });

  it('should handle network error', async () => {
    const networkError = new Error('Network request failed');

    (globalThis.fetch as any).mockRejectedValueOnce(networkError);

    const { result } = renderHook(() => useCacheRefresh());

    await act(async () => {
      await result.current.refreshCache();
    });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(toast.error).toHaveBeenCalledWith('Network request failed');
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('should handle unknown error type', async () => {
    (globalThis.fetch as any).mockRejectedValueOnce('Unknown error');

    const { result } = renderHook(() => useCacheRefresh());

    await act(async () => {
      await result.current.refreshCache();
    });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(toast.error).toHaveBeenCalledWith('Failed to start cache refresh');
  });

  it('should reset loading state after successful refresh', async () => {
    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ message: 'Success', status: 'ok' }),
    });

    const { result } = renderHook(() => useCacheRefresh());

    await act(async () => {
      await result.current.refreshCache();
    });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.loading).toBe(false);
  });

  it('should reset loading state after error', async () => {
    (globalThis.fetch as any).mockRejectedValueOnce(new Error('Network error'));

    const { result } = renderHook(() => useCacheRefresh());

    await act(async () => {
      await result.current.refreshCache();
    });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.loading).toBe(false);
  });
});

