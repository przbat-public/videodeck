import { logger } from './utils/logger';

export interface ShutdownOptions {
  server: { close(callback?: (error?: Error) => void): unknown };
  /**
   * Stops the download queue's jobs. A returned promise is what puts the queue
   * state on disk before the process can exit, so the close waits for it.
   */
  cancelJobs: () => void | Promise<void>;
  /** Resolves once all cancelled child processes are gone (bounded by its timeout) */
  awaitIdle?: (timeoutMs: number) => Promise<void>;
  /** Ends open SSE streams so server.close() does not wait on keep-alive connections */
  closeSseStreams?: () => void;
  /** Closes the library watcher (an open fs.watch handle keeps the loop alive) */
  stopLibraryWatch?: () => void;
  exit?: (code: number) => void;
  /** How long to wait for open connections before forcing an exit */
  forceExitMs?: number;
}

/** Whether the cancellation promised to do something the close has to wait for */
function isThenable(value: void | Promise<void>): value is Promise<void> {
  return typeof (value as Promise<void> | null)?.then === 'function';
}

/**
 * Start the cancellation and return what the close waits for: null for a
 * synchronous cancel, otherwise a promise that never rejects (a failed flush
 * is logged and the shutdown continues, since an exit is better than a hang).
 */
function startCancellation(cancelJobs: () => void | Promise<void>): Promise<void> | null {
  let result: void | Promise<void>;
  try {
    result = cancelJobs();
  } catch (error) {
    logger.error('Error while cancelling download jobs:', error);
    return null;
  }
  if (!isThenable(result)) {
    return null;
  }
  return result.catch((error: unknown) => {
    logger.error('Error while cancelling download jobs:', error);
  });
}

/**
 * Graceful shutdown: cancel the queue's jobs, end SSE streams, wait for the
 * yt-dlp children to die, stop accepting connections and exit cleanly once
 * the server closes — with a hard deadline as a backstop. Returns a function
 * that unregisters the signal handlers (tests).
 */
export function installShutdownHandlers(
  options: ShutdownOptions,
  signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'],
): () => void {
  const handler = () => shutdown(options);
  for (const signal of signals) {
    process.on(signal, handler);
  }
  return () => {
    for (const signal of signals) {
      process.removeListener(signal, handler);
    }
  };
}

export function shutdown(options: ShutdownOptions): void {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const forceExitMs = options.forceExitMs ?? 10_000;

  logger.info('Shutting down: cancelling download jobs and closing the server…');

  const forceTimer = setTimeout(() => {
    logger.error(`Server did not close within ${forceExitMs} ms — forcing exit`);
    exit(1);
  }, forceExitMs);
  forceTimer.unref();

  const closeServer = () => {
    try {
      options.server.close(() => {
        clearTimeout(forceTimer);
        logger.info('Server closed, bye');
        exit(0);
      });
    } catch (error) {
      logger.error('Error while closing the server:', error);
      exit(1);
    }
  };

  const drainThenClose = (): void => {
    if (options.awaitIdle) {
      void options
        .awaitIdle(forceExitMs)
        .then(closeServer)
        .catch((error: unknown) => {
          logger.error('Error while waiting for the download queue to drain:', error);
          closeServer();
        });
      return;
    }
    closeServer();
  };

  // Called in this tick so the kill starts immediately, but awaited when it
  // returns a promise: the queue's state file is written by the cancellation,
  // and `awaitIdle` cannot stand in for it because it resolves at once when no
  // child process is running.
  const cancelled = startCancellation(options.cancelJobs);
  options.closeSseStreams?.();
  options.stopLibraryWatch?.();

  if (cancelled === null) {
    drainThenClose();
    return;
  }
  void cancelled.then(drainThenClose);
}
