/**
 * Recognising "Elasticsearch is not reachable" in whatever shape the official
 * client throws it. The transport wraps the socket error (sometimes twice), so
 * the check walks the `cause` chain instead of trusting the outer error, and it
 * accepts both a known error name and a plain socket code.
 */

const UNAVAILABLE_ERROR_NAMES = new Set([
  'ConnectionError',
  'NoLivingConnectionsError',
  'TimeoutError',
  'RequestAbortedError',
]);

const UNAVAILABLE_SOCKET_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'ETIMEDOUT',
]);

/** How deep the cause chain is inspected before giving up */
const MAX_CAUSE_DEPTH = 5;

function isUnavailableNode(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { name?: unknown; code?: unknown; meta?: unknown };
  if (typeof candidate.name === 'string' && UNAVAILABLE_ERROR_NAMES.has(candidate.name)) {
    return true;
  }
  if (typeof candidate.code === 'string' && UNAVAILABLE_SOCKET_CODES.has(candidate.code)) {
    return true;
  }
  // Elasticsearch answers 503 while it is starting up or shutting down
  if (typeof candidate.name === 'string' && candidate.name === 'ResponseError') {
    const meta = candidate.meta as { statusCode?: unknown } | undefined;
    if (meta?.statusCode === 503) {
      return true;
    }
  }
  return false;
}

/**
 * True when the failure means the cluster cannot be reached right now, as
 * opposed to a bug, a mapping conflict or a bad query.
 */
export function isElasticsearchUnavailable(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (current === null || typeof current !== 'object' || seen.has(current)) {
      return false;
    }
    seen.add(current);
    if (isUnavailableNode(current)) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** Machine-readable code the API answers with when Elasticsearch is down */
export const ELASTICSEARCH_UNAVAILABLE_CODE = 'elasticsearch_unavailable';

/** The API's answer for an unreachable cluster, distinct from a 500 */
export class ElasticsearchUnavailableError extends Error {
  readonly code = ELASTICSEARCH_UNAVAILABLE_CODE;
  readonly statusCode = 503;

  constructor(message = 'Elasticsearch is not reachable') {
    super(message);
    this.name = 'ElasticsearchUnavailableError';
  }
}
