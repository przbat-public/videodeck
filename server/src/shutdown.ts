import { logger } from './utils/logger';

export interface ShutdownOptions {
  server: { close(callback?: (error?: Error) => void): unknown };
  /** Stops the download queue's jobs (kills running yt-dlp children) */
  cancelJobs: () => void;
  /** Resolves once all cancelled child processes are gone (bounded by its timeout) */
  awaitIdle?: (timeoutMs: number) => Promise<void>;
  /** Ends open SSE streams so server.close() does not wait on keep-alive connections */
  closeSseStreams?: () => void;
  exit?: (code: number) => void;
  /** How long to wait for open connections before forcing an exit */
  forceExitMs?: number;
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
  options.cancelJobs();
  options.closeSseStreams?.();

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

  if (options.awaitIdle) {
    void options
      .awaitIdle(forceExitMs)
      .then(closeServer)
      .catch((error: unknown) => {
        logger.error('Error while waiting for the download queue to drain:', error);
        closeServer();
      });
  } else {
    closeServer();
  }
}
