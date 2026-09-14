import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import cors from 'cors';
import videosRouter from './routes/videos';
import { createFolderRouter } from './routes/folder';
import type { DownloadQueueLike } from './routes/folder';
import { getCorsOrigins } from './config';
import { createAuthMiddleware, isAllowedCorsOrigin } from './routes/http';
import { logger } from './utils/logger';
import { metricsBody, metricsRegistry, recordRequest } from './metrics';
import { checkElasticsearchConnection } from './services/elasticsearchService';
import type { ApiError } from '@shared/api';

/**
 * Largest expected JSON body: bulk enqueue for a channel with thousands of
 * videos (`POST /api/folder/queue` with one `{ videoId }` per video).
 * body-parser's default of 100 kB is too small for that.
 */
export const JSON_BODY_LIMIT = '1mb';

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

  const start = Date.now();
  res.on('finish', () => {
    const durationMs = Date.now() - start;
    const route = req.route?.path ?? req.path;
    recordRequest(req.method, route, res.statusCode, durationMs);
    logger.info(
      `${req.method} ${req.originalUrl} → ${res.statusCode} (${durationMs}ms) [${requestId}]`
    );
  });
  next();
}

/**
 * Safety net for anything a handler did not catch itself. Express 5 forwards
 * rejected async handlers here, so the boilerplate `try/catch + sendError`
 * blocks are gone: a 500 now looks the same everywhere and the full error
 * lands in the log with its route.
 */
export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (res.headersSent) {
    next(error); // streaming response (SSE, sendFile) — let Express tear it down
    return;
  }
  logger.error(
    `Unhandled error in ${req.method} ${req.originalUrl} [${String(res.locals.requestId)}]:`,
    error
  );
  const body: ApiError = {
    error: 'Internal server error',
    message: error instanceof Error ? error.message : 'Unknown error',
  };
  res.status(500).json(body);
}

export function createApp(options: CreateAppOptions = {}): express.Express {
  const app = express();

  const extraCorsOrigins = getCorsOrigins();

  // Only browsers are subject to CORS; requests without an Origin header
  // (curl, the server itself) go through untouched.
  app.use(
    cors({
      origin: (origin, callback) => {
        callback(null, origin === undefined || isAllowedCorsOrigin(origin, extraCorsOrigins));
      },
    })
  );
  app.use(express.json({ limit: JSON_BODY_LIMIT }));
  app.use(requestLogger);

  // /health and /metrics stay public; everything else is behind the token
  // when set
  app.use('/api', createAuthMiddleware(options.apiToken));

  app.use('/api/videos', videosRouter);
  // /api/status, /api/folder/* (config, list.json, download queue)
  app.use('/api', createFolderRouter(options.downloadQueue));

  // Readiness probe: also tells the extension's "Test połączenia" whether
  // the whole stack (Elasticsearch included) is healthy
  app.get('/health', async (_req, res) => {
    const esUp = await checkElasticsearchConnection();
    res.status(esUp ? 200 : 503).json({
      status: esUp ? 'ok' : 'degraded',
      elasticsearch: esUp ? 'ok' : 'down',
    });
  });

  app.get('/metrics', async (_req, res) => {
    res.setHeader('Content-Type', metricsRegistry.contentType);
    res.end(await metricsBody());
  });

  app.use(errorHandler);

  return app;
}
