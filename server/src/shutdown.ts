import { logger } from './utils/logger';

export interface ShutdownOptions {
  server: { close(callback?: (error?: Error) => void): unknown };
  /** Stops the download queue's jobs (kills running yt-dlp children) */
  cancelJobs: () => void;
  exit?: (code: number) => void;
  /** How long to wait for open connections before forcing an exit */
  forceExitMs?: number;
}

/**
 * Graceful shutdown: cancel the queue's jobs, stop accepting connections and
 * exit cleanly once the server closes — with a hard deadline as a backstop.
 * Returns a function that unregisters the signal handlers (tests).
 */
export function installShutdownHandlers(
  options: ShutdownOptions,
  signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM']
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

  logger.info('Shutting down: cancelling download jobs and closing the server…');
  options.cancelJobs();

  const forceTimer = setTimeout(() => {
    logger.error(`Server did not close within ${options.forceExitMs ?? 10_000} ms — forcing exit`);
    exit(1);
  }, options.forceExitMs ?? 10_000);
  forceTimer.unref();

  try {
    options.server.close(() => {
      logger.info('Server closed, bye');
      exit(0);
    });
  } catch (error) {
    logger.error('Error while closing the server:', error);
    exit(1);
  }
}
