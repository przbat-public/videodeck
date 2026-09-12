import express from 'express';
import cors from 'cors';
import videosRouter from './routes/videos';
import folderRouter from './routes/folder';

/**
 * Largest expected JSON body: bulk enqueue for a channel with thousands of
 * videos (`POST /api/folder/queue` with one `{ videoId }` per video).
 * body-parser's default of 100 kB is too small for that.
 */
export const JSON_BODY_LIMIT = '1mb';

export function createApp(): express.Express {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  app.use('/api/videos', videosRouter);
  // /api/status, /api/folder/* (config, list.json, download queue)
  app.use('/api', folderRouter);

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  return app;
}
