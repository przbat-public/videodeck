import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import { downloadQueue } from './services/downloadQueue';

/**
 * Prometheus metrics for /metrics. Deliberately no collectDefaultMetrics:
 * its interval timer keeps test workers alive; the process-level defaults
 * can be re-enabled when the app gets a proper observability setup.
 */
export const metricsRegistry = new Registry();

export const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'HTTP requests served',
  labelNames: ['method', 'route', 'status'],
  registers: [metricsRegistry],
});

export const httpRequestDurationMs = new Histogram({
  name: 'http_request_duration_ms',
  help: 'HTTP request duration in milliseconds',
  labelNames: ['method', 'route'],
  buckets: [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
  registers: [metricsRegistry],
});

export const downloadQueueSize = new Gauge({
  name: 'download_queue_size',
  help: 'Jobs currently known to the download queue',
  registers: [metricsRegistry],
});

/** Record one finished request (called by the request logger) */
export function recordRequest(
  method: string,
  route: string,
  status: number,
  durationMs: number
): void {
  httpRequestsTotal.inc({ method, route, status });
  httpRequestDurationMs.observe({ method, route }, durationMs);
}

/** Text body of /metrics with the queue gauge refreshed */
export async function metricsBody(): Promise<string> {
  downloadQueueSize.set(downloadQueue.list().length);
  return metricsRegistry.metrics();
}
