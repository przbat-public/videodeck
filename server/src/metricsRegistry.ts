import { Registry } from 'prom-client';

/**
 * The Prometheus registry, in its own module: services can register metrics
 * without importing metrics.ts, whose downloadQueue import would otherwise
 * create a cycle (metrics → downloadQueue → videoScanner → summaryService).
 */
export const metricsRegistry = new Registry();
