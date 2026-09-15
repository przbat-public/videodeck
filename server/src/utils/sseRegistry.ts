import type { Response } from 'express';

/**
 * Registry of open SSE (Server-Sent Events) responses. Long-lived SSE
 * connections keep server.close() from finishing, so graceful shutdown ends
 * them explicitly first.
 */
const streams = new Set<Response>();

/** Track an SSE response; returns the unregister function. */
export function registerSseStream(res: Response): () => void {
  streams.add(res);
  return () => {
    streams.delete(res);
  };
}

/** End every open SSE stream (idempotent; used by graceful shutdown). */
export function closeAllSseStreams(): void {
  for (const res of streams) {
    res.end();
  }
  streams.clear();
}

/** Number of open SSE streams (tests). */
export function activeSseStreamCount(): number {
  return streams.size;
}
