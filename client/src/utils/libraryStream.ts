import { libraryEventSchema } from '@videodeck/shared/schemas';
import { feedSseBuffer, parseSseEvent } from '@videodeck/shared/sse';
import { applyLibraryFrame } from './libraryStatus';

/**
 * The browser's end of `GET /api/events`: one request per app load, held open
 * for the session, which is what lets a drive that arrives or leaves reach an
 * open page without a reload.
 *
 * The stream is notification only. Every accepted frame lands in the library
 * store, and the pages re-read what they render from the endpoints that own
 * that data, so a leaked or replayed frame can never become page state on its
 * own. A stream that ends or fails reconnects with a bounded backoff, and a
 * hidden tab lets it go: the opening frame resyncs everything, so holding a
 * connection open in a background tab buys nothing.
 *
 * Nothing here throws or logs: the health poll carries the same revision, so a
 * stream that never opens degrades to a slower page, not a broken one.
 */

/** First wait after a stream that ended without a frame; it doubles from there */
export const LIBRARY_STREAM_INITIAL_BACKOFF_MS = 1_000;

/** Ceiling for the reconnect wait, so a stream that never opens stays quiet */
export const LIBRARY_STREAM_MAX_BACKOFF_MS = 30_000;

let active = false;
let attempt = 0;
let controller: AbortController | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Open the stream, or return the stop for the one already running: the shell
 * calls this once per app load, and a second call must not add a connection.
 */
export function startLibraryStream(): () => void {
  if (active) {
    return stopLibraryStream;
  }
  active = true;
  attempt = 0;
  document.addEventListener('visibilitychange', onVisibilityChange);
  void connect();
  return stopLibraryStream;
}

export function stopLibraryStream(): void {
  if (!active) {
    return;
  }
  active = false;
  document.removeEventListener('visibilitychange', onVisibilityChange);
  clearRetry();
  controller?.abort();
  controller = null;
}

function clearRetry(): void {
  if (retryTimer !== null) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}

/**
 * Wait before the next attempt, doubling up to the ceiling. The count only
 * resets when a frame arrives: a server that accepts the connection and closes
 * it at once is a failing stream, not a working one.
 */
function scheduleReconnect(): void {
  const wait = Math.min(LIBRARY_STREAM_INITIAL_BACKOFF_MS * 2 ** attempt, LIBRARY_STREAM_MAX_BACKOFF_MS);
  attempt += 1;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void connect();
  }, wait);
}

/**
 * A hidden tab drops the connection and a visible one reopens it. The opening
 * frame carries the whole library, so nothing can be missed in between, and a
 * background tab holds no socket for a server that has other readers.
 */
function onVisibilityChange(): void {
  if (!active) {
    return;
  }
  if (document.visibilityState === 'hidden') {
    clearRetry();
    controller?.abort();
    controller = null;
    return;
  }
  attempt = 0;
  if (controller === null && retryTimer === null) {
    void connect();
  }
}

async function connect(): Promise<void> {
  if (!active || document.visibilityState === 'hidden') {
    return;
  }
  clearRetry();
  const current = new AbortController();
  controller = current;
  try {
    const response = await fetch('/api/events', { cache: 'no-store', signal: current.signal });
    if (current.signal.aborted) {
      return; // the tab hid or the app unmounted while the headers were on the way
    }
    if (!response.ok || response.body === null) {
      throw new Error(`library stream answered ${response.status}`);
    }
    await readFrames(response.body, current.signal);
  } catch {
    // Swallowed on purpose: the health poll keeps the revision moving and the
    // server's own state belongs to the banner, not to this stream.
  } finally {
    if (controller === current) {
      controller = null;
    }
    if (active && !current.signal.aborted) {
      scheduleReconnect();
    }
  }
}

async function readFrames(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let sawFrame = false;
  while (active && !signal.aborted) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    const chunk = feedSseBuffer(buffer, decoder.decode(value, { stream: true }));
    buffer = chunk.buffer;
    for (const raw of chunk.events) {
      // A frame the contract cannot read is dropped, the way the server drops
      // one it cannot write: neither side trusts the wire.
      const frame = parseSseEvent(libraryEventSchema, raw);
      if (frame === null) {
        continue;
      }
      if (!sawFrame) {
        sawFrame = true;
        attempt = 0;
      }
      applyLibraryFrame(frame);
    }
  }
}
