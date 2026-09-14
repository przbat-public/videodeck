import express from 'express';
import cors from 'cors';
import videosRouter from './routes/videos';
import folderRouter from './routes/folder';
import { CORS_ORIGINS } from './config';
import { createAuthMiddleware, isAllowedCorsOrigin } from './routes/http';

/**
 * Largest expected JSON body: bulk enqueue for a channel with thousands of
 * videos (`POST /api/folder/queue` with one `{ videoId }` per video).
 * body-parser's default of 100 kB is too small for that.
 */
export const JSON_BODY_LIMIT = '1mb';

export interface CreateAppOptions {
  /** Bearer token guarding /api; undefined means the API is open */
  apiToken?: string;
}

export function createApp(options: CreateAppOptions = {}): express.Express {
  const app = express();

  const extraCorsOrigins = (CORS_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

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

  // /health stays public; everything else is behind the token when set
  app.use('/api', createAuthMiddleware(options.apiToken));

  app.use('/api/videos', videosRouter);
  // /api/status, /api/folder/* (config, list.json, download queue)
  app.use('/api', folderRouter);

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  return app;
}
