import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installFetchMock, jsonResponse } from '../test/fetchMock';
import {
  getElasticsearchState,
  reportElasticsearchUnavailable,
  resetElasticsearchState,
} from '../utils/elasticsearchStatus';
import { useServerHealth } from './useServerHealth';

const fetchMock = installFetchMock();

describe('useServerHealth', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    resetElasticsearchState();
  });

  it('reports a healthy stack', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: 'ok', elasticsearch: 'ok' }));

    const { result } = renderHook(() => useServerHealth());

    await waitFor(() => expect(result.current.elasticsearch).toBe('ok'));
    expect(fetchMock).toHaveBeenCalledWith('/api/health', { cache: 'no-store' });
  });

  it('reports a degraded stack with Elasticsearch down', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: 'degraded', elasticsearch: 'down' }, 503));

    const { result } = renderHook(() => useServerHealth());

    await waitFor(() => expect(result.current.elasticsearch).toBe('down'));
  });

  it('leaves the state unknown when the server itself does not answer', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));

    const { result } = renderHook(() => useServerHealth());

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    // A restarting server is not "Elasticsearch is down": the pages own that
    // failure, and a banner claiming the wrong cause is worse than none
    expect(result.current.elasticsearch).toBe('unknown');
  });

  it('stays unknown when the probe answers something unreadable', async () => {
    // A proxy or a misconfigured reverse proxy can answer HTML with a 200
    fetchMock.mockResolvedValue(jsonResponse({ unexpected: true }));

    const { result } = renderHook(() => useServerHealth());

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(result.current.elasticsearch).toBe('unknown');
  });

  it('picks up a failure another request already reported', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: 'ok', elasticsearch: 'ok' }));
    const { result } = renderHook(() => useServerHealth());
    await waitFor(() => expect(result.current.elasticsearch).toBe('ok'));

    act(() => reportElasticsearchUnavailable());

    expect(result.current.elasticsearch).toBe('down');
  });

  it('rechecks on demand', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: 'degraded', elasticsearch: 'down' }, 503));
    const { result } = renderHook(() => useServerHealth());
    await waitFor(() => expect(result.current.elasticsearch).toBe('down'));

    fetchMock.mockResolvedValue(jsonResponse({ status: 'ok', elasticsearch: 'ok' }));
    await act(async () => {
      await result.current.recheck();
    });

    expect(result.current.elasticsearch).toBe('ok');
    expect(getElasticsearchState()).toBe('ok');
  });

  it('rechecks when the window regains focus', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: 'degraded', elasticsearch: 'down' }, 503));
    const { result } = renderHook(() => useServerHealth());
    await waitFor(() => expect(result.current.elasticsearch).toBe('down'));
    const calls = fetchMock.mock.calls.length;

    fetchMock.mockResolvedValue(jsonResponse({ status: 'ok', elasticsearch: 'ok' }));
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });

    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(calls));
    await waitFor(() => expect(result.current.elasticsearch).toBe('ok'));
  });

  it('rechecks when the tab becomes visible again', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get');
    visibility.mockReturnValue('hidden');
    fetchMock.mockResolvedValue(jsonResponse({ status: 'degraded', elasticsearch: 'down' }, 503));
    const { result } = renderHook(() => useServerHealth());
    await waitFor(() => expect(result.current.elasticsearch).toBe('down'));

    fetchMock.mockResolvedValue(jsonResponse({ status: 'ok', elasticsearch: 'ok' }));
    visibility.mockReturnValue('visible');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    await waitFor(() => expect(result.current.elasticsearch).toBe('ok'));
    visibility.mockRestore();
  });

  it('skips the poll while the tab is hidden', async () => {
    vi.useFakeTimers();
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    fetchMock.mockResolvedValue(jsonResponse({ status: 'ok', elasticsearch: 'ok' }));
    renderHook(() => useServerHealth(1_000));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const calls = fetchMock.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });

    expect(fetchMock.mock.calls.length).toBe(calls);
    visibility.mockRestore();
    vi.useRealTimers();
  });

  it('polls again while the tab is visible', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(jsonResponse({ status: 'ok', elasticsearch: 'ok' }));
    renderHook(() => useServerHealth(1_000));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const calls = fetchMock.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_100);
    });

    expect(fetchMock.mock.calls.length).toBeGreaterThan(calls);
    vi.useRealTimers();
  });

  it('stops polling after unmount', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(jsonResponse({ status: 'ok', elasticsearch: 'ok' }));
    const { unmount } = renderHook(() => useServerHealth(1_000));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const calls = fetchMock.mock.calls.length;

    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(fetchMock.mock.calls.length).toBe(calls);
    vi.useRealTimers();
  });
});
