import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getLibraryState, resetLibraryState } from './libraryStatus';
import { LIBRARY_STREAM_INITIAL_BACKOFF_MS, LIBRARY_STREAM_MAX_BACKOFF_MS, startLibraryStream } from './libraryStream';

/**
 * The stream is one long-lived GET /api/events, so every test drives it
 * through a stubbed fetch whose body is a real ReadableStream: the same shape
 * the browser hands the reader in production.
 */

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

/** A response whose body is already complete: the stream ends at once */
function endedResponse(chunks: string[] = [], status = 200): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(status === 200 ? body : null, { status });
}

/** A response that stays open until the returned close() runs */
function openResponse(chunks: string[] = []): { response: Response; close: () => void } {
  let streamController!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
      for (const chunk of chunks) {
        controller.enqueue(encode(chunk));
      }
    },
  });
  return { response: new Response(body, { status: 200 }), close: () => streamController.close() };
}

const libraryFrame = (revision: number, folders: string[]): string =>
  `data: ${JSON.stringify({ type: 'library', revision, folders, unavailable: [] })}\n\n`;

/** jsdom reports `visible` and lets a test redefine it (it is a getter) */
function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('libraryStream', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let stopStream: (() => void) | null = null;

  const start = (): void => {
    stopStream = startLibraryStream();
  };

  beforeEach(() => {
    resetLibraryState();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    stopStream?.();
    stopStream = null;
    setVisibility('visible');
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('lands a frame from the stream in the store', async () => {
    fetchMock.mockResolvedValue(openResponse([libraryFrame(2, ['/videos/a'])]).response);

    start();
    await vi.waitFor(() => expect(getLibraryState().revision).toBe(2));

    expect(fetchMock).toHaveBeenCalledWith('/api/events', expect.objectContaining({ cache: 'no-store' }));
    expect(getLibraryState().folders).toEqual(['/videos/a']);
    expect(getLibraryState().streamOpen).toBe(true);
  });

  it('drops a frame that does not match the contract', async () => {
    fetchMock.mockResolvedValue(openResponse(['data: {"type":"mystery"}\n\n']).response);

    start();
    await vi.waitFor(() => expect(getLibraryState().streamOpen).toBe(true));

    expect(getLibraryState().revision).toBe(0);
  });

  it('reconnects after the stream ends, waiting out the backoff first', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(endedResponse()).mockResolvedValue(openResponse().response);

    start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(LIBRARY_STREAM_INITIAL_BACKOFF_MS - 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('doubles the wait after a stream that could not be opened', async () => {
    vi.useFakeTimers();
    // Two outright failures, then a stream that stays open
    fetchMock
      .mockResolvedValueOnce(endedResponse([], 500))
      .mockResolvedValueOnce(endedResponse([], 500))
      .mockResolvedValue(openResponse().response);

    start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(LIBRARY_STREAM_INITIAL_BACKOFF_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // The second wait is twice the first, so the first backoff alone is not enough
    await vi.advanceTimersByTimeAsync(LIBRARY_STREAM_INITIAL_BACKOFF_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(LIBRARY_STREAM_INITIAL_BACKOFF_MS);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('opens one stream however many times it is started', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(openResponse().response);

    const stopFirst = startLibraryStream();
    const stopSecond = startLibraryStream();
    stopStream = stopFirst;
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchMock).toHaveBeenCalledTimes(1);

    stopFirst();
    stopSecond();
  });

  it('ends the reconnect loop when it is stopped', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(endedResponse());

    start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    stopStream?.();
    stopStream = null;
    await vi.advanceTimersByTimeAsync(LIBRARY_STREAM_MAX_BACKOFF_MS * 2);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getLibraryState().streamOpen).toBe(false);
  });

  it('pauses on a hidden tab and reopens on a visible one', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(openResponse().response);

    start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(LIBRARY_STREAM_MAX_BACKOFF_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
