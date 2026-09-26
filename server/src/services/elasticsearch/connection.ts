import { Client } from '@elastic/elasticsearch';
import { Gauge } from '@prometheus-io/client';
import { ELASTICSEARCH_URL } from '../../config';
import { metricsRegistry } from '../../metricsRegistry';
import { logger } from '../../utils/logger';
import { ElasticsearchUnavailableError } from '../elasticsearchErrors';

/**
 * Client singletons, the outage state that gates reads, and the health probe.
 *
 * The `let` bindings below are the single copies for the whole Elasticsearch
 * layer: index lifecycle, bulk indexing and search all go through the accessors
 * exported here, so they share one client, one probe client and one outage
 * window.
 */

let client: Client | null = null;

export const getElasticsearchClient = (): Client => {
  if (!client) {
    client = new Client({
      node: ELASTICSEARCH_URL,
      // Elasticsearch hiccups happen (GC pauses, container restarts) — the
      // official client retries transient failures instead of failing the
      // request immediately
      maxRetries: 3,
      requestTimeout: 30_000,
    });
  }
  return client;
};

let probeClient: Client | null = null;

/**
 * A separate client for health probes and quick alias checks: short timeout,
 * no retries. The regular client retries for up to 2 minutes per call, which
 * would hang /health and /api/status for minutes when Elasticsearch is
 * unreachable-but-not-refused.
 */
export function getProbeClient(): Client {
  if (!probeClient) {
    probeClient = new Client({
      node: ELASTICSEARCH_URL,
      maxRetries: 0,
      requestTimeout: 3_000,
    });
  }
  return probeClient;
}

/**
 * Injection point: replace the client (tests, custom transport setup). Pass
 * null to fall back to the lazy defaults built from ELASTICSEARCH_URL. Both
 * accessors return the override — the probe client shares the same mock in
 * tests, in production each lazy accessor builds its own.
 */
export function setElasticsearchClient(override: Client | null): void {
  client = override;
  probeClient = override;
}

/** When a request last found the cluster unreachable, null while it is fine */
let unavailableSince: number | null = null;

/** When a probe last cleared an outage, null until one does */
let recoveredAt: number | null = null;

/**
 * How long a fresh outage keeps reads from even trying. The regular client
 * retries transient failures for up to two minutes, and nothing in a stopped
 * container is going to answer inside that: a second search while the first is
 * still failing should return at once.
 */
const FAIL_FAST_WINDOW_MS = 5_000;

/**
 * How long a recovery outranks a failure that arrives right after it.
 *
 * A probe that finds the cluster back replaces the client, but requests that
 * failed on the old one can still land afterwards and arm the window again.
 * The next read then answered "not reachable" in a millisecond while the
 * cluster had answered seconds before, and the user saw an empty search.
 * Within this grace period, and only after a recovery, a read tries instead of
 * being refused. A fresh outage is unaffected: nothing was recovered there.
 */
const RECOVERY_GRACE_MS = 10_000;

/** 1 when the last observation reached the cluster, 0 after a failure */
export const elasticsearchUpGauge = new Gauge({
  name: 'elasticsearch_up',
  help: '1 when Elasticsearch answered the last check, 0 after a failed request',
  registers: [metricsRegistry],
});

/**
 * Record that a request could not reach the cluster. The error handler calls
 * this for every classified failure, so the next successful probe knows it has
 * a recovery on its hands (the probe runs on its own client and cannot see the
 * other one's broken pool).
 */
export function noteElasticsearchUnavailable(now: number = Date.now()): void {
  unavailableSince ??= now;
  elasticsearchUpGauge.set(0);
}

/** The cluster answered: forget the outage (the probe calls this) */
export function clearElasticsearchOutage(): void {
  unavailableSince = null;
  recoveredAt = null;
  elasticsearchUpGauge.set(1);
}

/**
 * Refuse a read while an outage is fresh, instead of letting it wait out the
 * client's retry budget. Only reads use this: a write that is skipped here
 * would lose its batch, and the queue already retries those.
 *
 * Exported for the read paths in ./search; every caller shares the same outage
 * state, this module's `unavailableSince` and `recoveredAt`.
 */
export function assertElasticsearchReachable(now: number = Date.now()): void {
  if (unavailableSince === null || now - unavailableSince >= FAIL_FAST_WINDOW_MS) {
    return;
  }
  // A probe that just reached the cluster outranks a failure that came from
  // the client it replaced. Refusing here would answer "not reachable" for a
  // cluster that answered moments ago, and the user would see an empty search
  // instead of results.
  if (recoveredAt !== null && now - recoveredAt < RECOVERY_GRACE_MS) {
    return;
  }
  throw new ElasticsearchUnavailableError();
}

/** Drop the long-lived client so the next call opens fresh connections */
export function resetElasticsearchClient(): void {
  const previous = client;
  client = null;
  void previous?.close().catch(() => {
    /* the client is being discarded either way */
  });
}

/**
 * One cheap ping. It stays silent on purpose: `/health` is polled, and the
 * caller decides what to log (the boot line, the throttled request line). A
 * refused connection is immediate, so probing while down costs nothing.
 *
 * When the probe finds the cluster back, the long-lived client is replaced:
 * its connection pool sat on dead sockets through the outage and backs off
 * exponentially before trying again, which would fail the user's first search
 * right after the banner cleared.
 */
export async function checkElasticsearchConnection(): Promise<boolean> {
  try {
    await getProbeClient().ping();
  } catch {
    noteElasticsearchUnavailable();
    return false;
  }
  if (unavailableSince !== null) {
    logger.info('Elasticsearch answered again — reconnecting with a fresh client');
    // Marked after the clear, which resets it, so the grace survives the very
    // probe that proves the cluster is back.
    clearElasticsearchOutage();
    recoveredAt = Date.now();
    resetElasticsearchClient();
  } else {
    elasticsearchUpGauge.set(1);
  }
  return true;
}
