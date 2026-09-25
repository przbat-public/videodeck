import { Counter, Gauge, Histogram } from '@prometheus-io/client';
import { metricsRegistry } from './metricsRegistry';
import { downloadQueue } from './services/downloadQueue';

export { metricsRegistry };

/**
 * Prometheus metrics for /metrics. Deliberately no collectDefaultMetrics:
 * its interval timer keeps test workers alive; the process-level defaults
 * can be re-enabled when the app gets a proper observability setup.
 */

export const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'HTTP requests served',
  labelNames: ['method', 'route', 'status'],
  registers: [metricsRegistry],
});

export const httpRequestDurationSeconds = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [metricsRegistry],
});

export const downloadQueueSize = new Gauge({
  name: 'download_queue_size',
  help: 'Jobs currently known to the download queue',
  registers: [metricsRegistry],
});

export const sseStreamsOpen = new Gauge({
  name: 'sse_streams_open',
  help: 'SSE streams currently held open by clients',
  registers: [metricsRegistry],
});

/** Record one finished request (called by the request logger) */
export function recordRequest(method: string, route: string, status: number, durationMs: number): void {
  httpRequestsTotal.inc({ method, route, status });
  httpRequestDurationSeconds.observe({ method, route }, durationMs / 1000);
}

/** Text body of /metrics with the queue gauge refreshed */
export async function metricsBody(): Promise<string> {
  downloadQueueSize.set(downloadQueue.list().length);
  return metricsRegistry.metrics();
}
