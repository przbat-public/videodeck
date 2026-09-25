import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n';
import type { MockResponse } from '../test/fetchMock';
import { installFetchMock } from '../test/fetchMock';
import { toast } from '../test/toastMock';
import { useVideoSummary } from './useVideoSummary';

const fetchMock = installFetchMock();

// The shared toast mock only models success/error/loading; the hook also
// dismisses the loading toast on a quiet 404 — add that here.
const dismiss = vi.fn();
Object.assign(toast, { dismiss });

const LOADING_TOAST_ID = 'toast-id';

const json = (body: unknown, status = 200): MockResponse => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

describe('useVideoSummary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockReset();
  });

  it('does not fetch and fires no toast without a subtitle file', async () => {
    const { result } = renderHook(() => useVideoSummary('video1', undefined));

    await waitFor(() => {
      expect(result.current.state.loading).toBe(false);
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(toast.loading).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('shows the summary and a success toast', async () => {
    fetchMock.mockResolvedValueOnce(json({ summary: 'A summary.' }));

    const { result } = renderHook(() => useVideoSummary('video1', 'video1.vtt'));

    await waitFor(() => {
      expect(result.current.state.loading).toBe(false);
    });

    expect(result.current.state.summary).toBe('A summary.');
    expect(result.current.truncated).toBe(false);
    expect(fetchMock).toHaveBeenCalledWith('/api/videos/video1/summary', { signal: expect.any(AbortSignal) });
    expect(toast.loading).toHaveBeenCalledWith('Generowanie streszczenia...');
    expect(toast.success).toHaveBeenCalledWith('Streszczenie gotowe', { id: LOADING_TOAST_ID });
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('propagates the truncated flag from the response', async () => {
    fetchMock.mockResolvedValueOnce(json({ summary: 'A short summary.', truncated: true }));

    const { result } = renderHook(() => useVideoSummary('video1', 'video1.vtt'));

    await waitFor(() => {
      expect(result.current.state.loading).toBe(false);
    });

    expect(result.current.truncated).toBe(true);
    expect(result.current.state.summary).toBe('A short summary.');
  });

  it('surfaces the distinct 503 message instead of the generic failure toast', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({ error: 'disabled' }) });

    const { result } = renderHook(() => useVideoSummary('video1', 'video1.vtt'));

    await waitFor(() => {
      expect(result.current.state.loading).toBe(false);
    });

    const unavailable = 'Streszczenia są wyłączone — ustaw OPENAI_API_KEY na serwerze';
    expect(result.current.state.error).toBe(unavailable);
    expect(toast.error).toHaveBeenCalledWith(unavailable, { id: LOADING_TOAST_ID });
    expect(toast.error).not.toHaveBeenCalledWith('Nie udało się wygenerować streszczenia', expect.anything());
  });

  it('stays quiet on a 404 — no error toast, loading toast dismissed', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({ error: 'Subtitle not found' }) });

    const { result } = renderHook(() => useVideoSummary('video1', 'video1.vtt'));

    await waitFor(() => {
      expect(result.current.state.loading).toBe(false);
    });

    expect(dismiss).toHaveBeenCalledWith(LOADING_TOAST_ID);
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    expect(result.current.state.summary).toBeNull();
  });

  it('reports generic failures as an error toast', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({ error: 'boom' }) });

    const { result } = renderHook(() => useVideoSummary('video1', 'video1.vtt'));

    await waitFor(() => {
      expect(result.current.state.loading).toBe(false);
    });

    expect(toast.error).toHaveBeenCalledWith('Nie udało się wygenerować streszczenia', { id: LOADING_TOAST_ID });
    expect(result.current.state.error).toBe(i18n.t('errors.loadSummary'));
  });

  it('handles network errors', async () => {
    fetchMock.mockRejectedValueOnce(new Error('Network error'));

    const { result } = renderHook(() => useVideoSummary('video1', 'video1.vtt'));

    await waitFor(() => {
      expect(result.current.state.loading).toBe(false);
    });

    expect(result.current.state.error).toBe('Network error');
    expect(toast.error).toHaveBeenCalledWith('Nie udało się wygenerować streszczenia', { id: LOADING_TOAST_ID });
  });
});
