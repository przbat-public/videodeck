import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useCategories } from './useCategories';
import { installFetchMock, jsonResponse } from '../test/fetchMock';

const fetchMock = installFetchMock();

describe('useCategories', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads the categories once on mount', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ categories: ['fpv', 'psychology'] }));

    const { result } = renderHook(() => useCategories());

    expect(result.current.categories).toEqual([]);
    await waitFor(() => {
      expect(result.current.categories).toEqual(['fpv', 'psychology']);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/videos/categories', {
      signal: expect.any(AbortSignal),
    });
  });

  it('tolerates a response without a categories array', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));

    const { result } = renderHook(() => useCategories());

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(result.current.categories).toEqual([]);
  });

  it('logs and leaves the filter empty when the request fails', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'nope' }, 500));

    const { result } = renderHook(() => useCategories());

    await waitFor(() => {
      expect(console.error).toHaveBeenCalledWith(
        'Failed to load categories:',
        expect.objectContaining({ message: 'HTTP error! status: 500' })
      );
    });
    expect(result.current.categories).toEqual([]);
  });

  it('does not set state after unmount', async () => {
    let resolveFetch!: (response: ReturnType<typeof jsonResponse>) => void;
    fetchMock.mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      })
    );

    const { result, unmount } = renderHook(() => useCategories());
    unmount();
    resolveFetch(jsonResponse({ categories: ['fpv'] }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(result.current.categories).toEqual([]);
  });
});
