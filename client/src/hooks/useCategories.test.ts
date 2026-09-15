import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { installFetchMock, jsonResponse } from '../test/fetchMock';
import { useCategories } from './useCategories';

const fetchMock = installFetchMock();

describe('useCategories', () => {
  beforeEach(() => {
    fetchMock.mockReset();
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

  it('leaves the filter empty when the request fails', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'nope' }, 500));

    const { result } = renderHook(() => useCategories());

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(result.current.categories).toEqual([]);
  });

  it('does not set state after unmount', async () => {
    let resolveFetch!: (response: ReturnType<typeof jsonResponse>) => void;
    fetchMock.mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
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
