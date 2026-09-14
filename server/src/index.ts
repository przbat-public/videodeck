import dotenv from 'dotenv';
import { validateVideosFolder } from './utils/videoPathUtils';
import { createApp } from './app';
import { API_TOKEN, HOST } from './config';
import { logger } from './utils/logger';

dotenv.config();

const PORT = Number(process.env.PORT) || 3001;

// Start server
async function startServer() {
  try {
    await validateVideosFolder();
    logger.info('Videos folder(s) validated');
    logger.info('Server ready. Use GET /api/videos/refreshCache to index videos.');

    const app = createApp(API_TOKEN ? { apiToken: API_TOKEN } : {});
    app.listen(PORT, HOST, () => {
      logger.info(`Server running on http://${HOST}:${PORT}`);
      if (!API_TOKEN) {
        logger.warn(
          'API_TOKEN is not set — the API is unauthenticated and reachable by every local process and browser tab. Set it in .env and in the Chrome extension options.'
        );
      }
    });
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();
