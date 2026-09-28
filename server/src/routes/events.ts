import type { LibraryEvent } from '@videodeck/shared/api';
import { libraryEventSchema } from '@videodeck/shared/schemas';
import { sseStreamsOpen } from '../metrics';
import type { LibrarySnapshot } from '../services/libraryState';
import { getLibrarySnapshot, subscribeLibraryChanges } from '../services/libraryState';
import { logger } from '../utils/logger';
import { registerSseStream } from '../utils/sseRegistry';
import type { NoParams, RouteHandler } from './http';
import { firstZodError } from './validation';

/**
 * GET /api/events: the stream a page holds open for a whole session, which is
 * what lets a drive plugged in while the page is open arrive without a reload.
 *
 * One channel carries library changes. The frame a connection opens with is the
 * snapshot of that moment, so a late or reconnecting client resyncs without
 * asking; every later frame says what moved. The stream is notification only:
 * a client re-reads `/api/status` and whatever else it renders, so folders keep
 * one source of truth and a frame never becomes page state on its own.
 *
 * Built from the parts the download stream uses: the shutdown registry, the
 * open-stream gauge, the heartbeat comments and the schema check before the
 * wire. Closing the connection releases all of them.
 */

/** Heartbeat comments keep a quiet stream alive through proxies and nginx */
const HEARTBEAT_MS = 15_000;

/** The frame for one snapshot, with the difference against the last one sent */
function toLibraryFrame(snapshot: LibrarySnapshot, described: LibrarySnapshot | null): LibraryEvent {
  const frame: LibraryEvent = {
    type: 'library',
    revision: snapshot.revision,
    folders: [...snapshot.folders],
    unavailable: [...snapshot.unavailable],
  };
  if (described === null) {
    // The opening frame has nothing to compare against, so it reports no change
    return frame;
  }
  const before = new Set(described.folders);
  const after = new Set(snapshot.folders);
  return {
    ...frame,
    added: snapshot.folders.filter((folderPath) => !before.has(folderPath)),
    removed: described.folders.filter((folderPath) => !after.has(folderPath)),
  };
}

export const getEvents: RouteHandler<NoParams, never> = (_req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Tracked so graceful shutdown can end the stream and let server.close()
  // finish instead of waiting on the keep-alive connection.
  const unregister = registerSseStream(res);
  sseStreamsOpen.inc();

  /** Last snapshot this stream described; null until the opening frame is out */
  let described: LibrarySnapshot | null = null;
  let open = true;

  const send = (frame: LibraryEvent): void => {
    if (!open) {
      return;
    }
    // Every frame is validated against the shared contract before it reaches
    // the wire: a malformed frame would corrupt the client's stream parser.
    const parsed = libraryEventSchema.safeParse(frame);
    if (!parsed.success) {
      logger.warn(`Dropping invalid SSE event ${JSON.stringify(frame)}: ${firstZodError(parsed.error)}`);
      return;
    }
    res.write(`data: ${JSON.stringify(parsed.data)}\n\n`);
  };

  const sendSnapshot = (): void => {
    const snapshot = getLibrarySnapshot();
    send(toLibraryFrame(snapshot, described));
    described = snapshot;
  };

  // Subscribed before the opening frame so a change landing in between is not
  // lost. While `described` is still null that change needs no frame of its
  // own: the opening send below reads the newest snapshot anyway.
  const unsubscribe = subscribeLibraryChanges(() => {
    if (described !== null) {
      sendSnapshot();
    }
  });

  const heartbeat = setInterval(() => {
    if (open) {
      res.write(': ping\n\n');
    }
  }, HEARTBEAT_MS);

  // The response, not the request: the request's 'close' fires once its body
  // has been consumed, while the response's fires when the client goes away.
  let released = false;
  const release = (): void => {
    if (released) {
      return;
    }
    released = true;
    open = false;
    clearInterval(heartbeat);
    unsubscribe();
    unregister();
    sseStreamsOpen.dec();
  };
  res.on('close', release);

  sendSnapshot();
};
