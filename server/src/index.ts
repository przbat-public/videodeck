import dotenv from 'dotenv';
import { validateVideosFolder } from './utils/videoPathUtils';
import { createApp } from './app';
import { logger } from './utils/logger';

dotenv.config();

const PORT = process.env.PORT || 3001;

// Start server
async function startServer() {
  try {
    await validateVideosFolder();
    logger.info('Videos folder(s) validated');
    logger.info('Server ready. Use GET /api/videos/refreshCache to index videos.');

    const app = createApp();
    app.listen(PORT, () => {
      logger.info(`Server running on http://localhost:${PORT}`);
    });
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();
