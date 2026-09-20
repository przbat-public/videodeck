import { randomUUID } from 'node:crypto';
import type { ApiError } from '@videodeck/shared/api';
import cors from 'cors';
import type { NextFunction, Request, Response } from 'express';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import {
  getAllowedHosts,
  getCorsOrigins,
  getExtensionOrigins,
  getRateLimitMax,
  getRateLimitWindowMs,
  isTokenRequired,
} from './config';
import { metricsBody, metricsRegistry, recordRequest } from './metrics';
import type { DownloadQueueLike } from './routes/folder';
import { createFolderRouter } from './routes/folder';
import { createAuthMiddleware, isAllowedCorsOrigin } from './routes/http';
import videosRouter from './routes/videos';
import { isElasticsearchUnavailable } from './services/elasticsearchErrors';
import { checkElasticsearchConnection } from './services/elasticsearchService';
import { logger } from './utils/logger';
import { describeError, LogThrottle } from './utils/logThrottle';

/**
 * Largest expected JSON body: bulk enqueue for a channel with thousands of
 * videos (`POST /api/folder/queue` with one `{ videoId }` per video).
 * body-parser's default of 100 kB is too small for that.
 */
export const JSON_BODY_LIMIT = '1mb';

/** How long a /health probe trusts the previous Elasticsearch check */
const HEALTH_CACHE_TTL_MS = 5_000;

export interface CreateAppOptions {
  /** Bearer token guarding /api; undefined means the API is open */
  apiToken?: string;
  /** Download queue to back /api/folder/queue* (defaults to the app instance) */
  downloadQueue?: DownloadQueueLike;
}

/** One log line and one metrics sample per finished request */
function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const requestId = randomUUID();
  res.locals.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);

  // Captured here, not read from `req.url` later: while a mounted router
  // handles the request Express rewrites `req.url` to the path inside the
  // mount, and `res.on('finish')` can still see that shortened form ("/search"
  // instead of "/api/videos/search").
  const requestPath = req.originalUrl.split('?')[0] ?? req.originalUrl;

  const start = Date.now();
  res.on('finish', () => {
    const durationMs = Date.now() - start;
    // The route template ("/api/videos/:identifier/details") keeps the
    // cardinality bounded; unregistered paths collapse into "unmatched"
    // instead of a new series per URL (every filename would be one).
    const route = req.route?.path ?? 'unmatched';
    recordRequest(req.method, route, res.statusCode, durationMs);
    // The path, not the whole URL: a query string carries folder paths and
    // search phrases, and the log is where they would outlive the request.
    logger.info(`${req.method} ${requestPath} → ${res.statusCode} (${durationMs}ms) [${requestId}]`);
  });
  next();
}

/**
 * Host-header guard against DNS rebinding: a malicious domain can resolve to
 * 127.0.0.1, and the browser then sends its own Host header along — without
 * this check such a page could drive the local API like the real client.
 * Loopback hosts are always allowed; `extraHosts` (ALLOWED_HOSTS) extends
 * the list for LAN setups. Requests without a Host header (HTTP/1.0) pass.
 */
function createHostGuard(extraHosts: readonly string[]): (req: Request, res: Response, next: NextFunction) => void {
  const allowed = new Set(['localhost', '127.0.0.1', '::1', ...extraHosts]);
  return (req, res, next) => {
    const rawHost = req.headers.host;
    if (rawHost === undefined) {
      next();
      return;
    }
    // Host may carry a port ("localhost:3000") and IPv6 brackets ("[::1]:8080")
    const host = rawHost.toLowerCase().startsWith('[')
      ? rawHost.toLowerCase().replace(/^\[(.*)\](:\d+)?$/, '$1')
      : rawHost.toLowerCase().replace(/:\d+$/, '');
    if (!allowed.has(host)) {
      res.status(403).json({ error: 'Forbidden', message: 'Unknown Host header' });
      return;
    }
    next();
  };
}

/**
 * A stopped Elasticsearch fails every request that touches it, and each failure
 * used to print a multi-level stack. The compact line is throttled, because the
 * status page, the channel list, every search and the health poll all fail at
 * once and one line says it. Exported so a test can start a fresh window.
 */
export const elasticsearchUnavailableThrottle = new LogThrottle(30_000);

/**
 * Safety net for anything a handler did not catch itself. Express 5 forwards
 * rejected async handlers here, so the boilerplate `try/catch + sendError`
 * blocks are gone: a 500 now looks the same everywhere and the full error
 * lands in the log with its route.
 *
 * The response body is generic on purpose: `error.message` may carry file
 * paths, tokens or library internals that must not leak to the client.
 *
 * An unreachable Elasticsearch is the one exception. It is not a bug, it is a
 * dependency the operator can see to, so it answers 503 with a code the client
 * translates, and the log keeps one line instead of a stack per request.
 */
export function errorHandler(error: unknown, req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    next(error); // streaming response (SSE, sendFile) — let Express tear it down
    return;
  }
  if (isElasticsearchUnavailable(error)) {
    if (elasticsearchUnavailableThrottle.shouldLog()) {
      logger.warn(
        `Elasticsearch unreachable during ${req.method} ${req.path}: ${describeError(error)} (further failures log once per 30s)`,
      );
    }
    const unavailableBody: ApiError = {
      error: 'Elasticsearch is not reachable',
      code: 'elasticsearch_unavailable',
    };
    res.status(503).json(unavailableBody);
    return;
  }
  logger.error(`Unhandled error in ${req.method} ${req.path} [${String(res.locals.requestId)}]:`, error);
  const body: ApiError = { error: 'Internal server error' };
  res.status(500).json(body);
}

export function createApp(options: CreateAppOptions = {}): express.Express {
  const app = express();

  // No ETags for `res.json`: an API answer is per-request state, not a
  // representation to revalidate. Express answered the browser's conditional
  // polls with `304 Not Modified` and no body, and `fetch` reports a 304 as
  // `ok: false`, so the client showed "could not load the queue" while the
  // queue was healthy. File responses keep their own `Cache-Control` and
  // `Last-Modified`, which is what the player and the thumbnails rely on.
  app.set('etag', false);

  const extraCorsOrigins = getCorsOrigins();
  const extensionOrigins = getExtensionOrigins();

  // DNS-rebinding guard first — every request pays the Host check
  app.use(createHostGuard(getAllowedHosts()));

  app.use(helmet());

  // Broad-but-bounded rate limit: stops runaway scripts and the browser tab
  // from hammering the server; the queue poll (1.5 s) stays far below it.
  app.use(
    rateLimit({
      windowMs: getRateLimitWindowMs(),
      limit: getRateLimitMax(),
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'Too many requests' },
    }),
  );

  // Only browsers are subject to CORS; requests without an Origin header
  // (curl, the server itself) go through untouched.
  app.use(
    cors({
      origin: (origin, callback) => {
        callback(null, origin === undefined || isAllowedCorsOrigin(origin, extraCorsOrigins, extensionOrigins));
      },
    }),
  );
  app.use(express.json({ limit: JSON_BODY_LIMIT }));
  app.use(requestLogger);

  // /health and /health/live stay public; /metrics and everything else are
  // behind the token when set (metrics leak route cardinality and OpenAI
  // cost counters). REQUIRE_API_TOKEN closes open mode entirely.
  const auth = createAuthMiddleware(options.apiToken, isTokenRequired());
  app.use('/api', auth);
  app.use('/metrics', auth);

  // The API is live state the pages poll, so browsers must not serve it from a
  // cache between polls. Route handlers that serve content with a longer life
  // (thumbnails, videos) set their own Cache-Control and win by being later.
  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  app.use('/api/videos', videosRouter);
  // /api/status, /api/folder/* (config, list.json, download queue)
  app.use('/api', createFolderRouter(options.downloadQueue));

  // Readiness probe: also tells the extension's "Test connection" (pl:
  // "Test połączenia") whether
  // the whole stack (Elasticsearch included) is healthy. The ES check is
  // cached for a few seconds so a polling dashboard does not ping ES per hit.
  let healthCache: { checkedAt: number; esUp: boolean } | null = null;
  app.get('/health', async (_req, res) => {
    const now = Date.now();
    // Only a healthy answer is cached. While Elasticsearch is down every probe
    // runs (a refused connection is instant and silent), so the client sees the
    // recovery as soon as it happens instead of a stale 'down' for the TTL.
    if (!healthCache?.esUp || now - healthCache.checkedAt > HEALTH_CACHE_TTL_MS) {
      healthCache = { checkedAt: now, esUp: await checkElasticsearchConnection() };
    }
    const esUp = healthCache.esUp;
    res.status(esUp ? 200 : 503).json({
      status: esUp ? 'ok' : 'degraded',
      elasticsearch: esUp ? 'ok' : 'down',
    });
  });

  // Liveness probe: the process answers — no dependencies involved
  app.get('/health/live', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.get('/metrics', async (_req, res) => {
    res.setHeader('Content-Type', metricsRegistry.contentType);
    res.end(await metricsBody());
  });

  // Unknown paths answer JSON like the rest of the API (Express' default
  // would be an HTML 404 page)
  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.use(errorHandler);

  return app;
}
