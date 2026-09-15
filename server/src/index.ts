import dotenv from 'dotenv';
import { createApp } from './app';
import { getApiToken, getHost } from './config';
import { validateEnv } from './env';
import { downloadQueue } from './services/downloadQueue';
import { getYtDlpVersion } from './services/ytdlp';
import { installShutdownHandlers } from './shutdown';
import { logger } from './utils/logger';
import { validateVideosFolder } from './utils/videoPathUtils';

dotenv.config();

// Fail fast on a misconfigured environment (typo'd names, bad numbers) —
// validateEnv throws one error listing every problem.
const env = validateEnv(process.env);
const PORT = env.PORT;

// Start server
async function startServer() {
  try {
    await validateVideosFolder();
    logger.info('Videos folder(s) validated');
    logger.info('Server ready. Use GET /api/videos/refreshCache to index videos.');

    // YouTube changes break old yt-dlp releases regularly — the version in the
    // boot log is the first thing to check when downloads start failing.
    const ytDlpVersion = await getYtDlpVersion();
    if (ytDlpVersion !== null) {
      logger.info(`yt-dlp version: ${ytDlpVersion}`);
    } else {
      logger.warn('yt-dlp not found (yt-dlp --version failed) — downloads will fail until it is installed');
    }

    const apiToken = getApiToken();
    const host = getHost();
    const app = createApp(apiToken ? { apiToken } : {});
    const server = app.listen(PORT, host, () => {
      logger.info(`Server running on http://${host}:${PORT}`);
      if (!apiToken) {
        logger.warn(
          'API_TOKEN is not set — the API is unauthenticated and reachable by every local process and browser tab. Set it in .env and in the Chrome extension options.',
        );
      }
    });

    // Ctrl+C / docker stop: cancel yt-dlp jobs and close cleanly
    installShutdownHandlers({
      server,
      cancelJobs: () => downloadQueue.cancelAll(),
    });
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();
