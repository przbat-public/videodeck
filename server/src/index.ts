import dotenv from 'dotenv';
import { createApp } from './app';
import { startServing } from './boot';
import { ELASTICSEARCH_URL, getApiToken, getHost } from './config';
import { validateEnv } from './env';
import { downloadQueue, restoreQueueState } from './services/downloadQueue';
import {
  checkElasticsearchConnection,
  sweepOrphanIndexVersions,
  warnOnLegacyMappings,
} from './services/elasticsearchService';
import { startLibraryWatch, stopLibraryWatch } from './services/libraryState';
import { getYtDlpVersion } from './services/ytdlp';
import { installShutdownHandlers } from './shutdown';
import { logger } from './utils/logger';
import { closeAllSseStreams } from './utils/sseRegistry';
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

    // Watch the library roots from here on: a drive plugged in while the
    // server runs has to reach the folder list without a restart.
    startLibraryWatch();

    // Re-enqueue jobs persisted by a previous run (reboot recovery).
    const restored = await restoreQueueState();
    if (restored > 0) {
      logger.info(`Restored ${restored} queued job(s) from the previous run`);
    }

    logger.info('Server ready. Use POST /api/videos/refreshCache to index videos.');

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
    // The port opens first and the Elasticsearch housekeeping follows without
    // being awaited: a cluster that is slow or down at boot delays nothing, and
    // a failing check is one warning instead of a dead server.
    const server = startServing(
      () =>
        app.listen(PORT, host, () => {
          logger.info(`Server running on http://${host}:${PORT}`);
          if (!apiToken) {
            logger.warn(
              'API_TOKEN is not set — the API is unauthenticated and reachable by every local process and browser tab. Set it in .env and in the Chrome extension options.',
            );
          }
        }),
      [
        {
          // One clear line about Elasticsearch at boot. With it down, search,
          // the index read on the status page and every reindex degrade, and
          // the first request would otherwise be where the operator finds out.
          name: 'Elasticsearch boot probe',
          run: async () => {
            const up = await checkElasticsearchConnection();
            if (!up) {
              logger.warn(
                `Elasticsearch is not reachable at ${ELASTICSEARCH_URL} — search, index reads and indexing degrade until it comes back`,
              );
            }
          },
        },
        {
          name: 'Orphan index sweep',
          run: () => sweepOrphanIndexVersions(),
        },
        {
          name: 'Legacy mapping check',
          run: () => warnOnLegacyMappings(),
        },
      ],
    );

    // Ctrl+C / docker stop: stop the yt-dlp jobs (the state file keeps them for
    // the next boot), end SSE streams and close cleanly once the killed
    // children are gone.
    installShutdownHandlers({
      server,
      // Fire-and-forget: stopForShutdown flushes the interrupted jobs to the
      // state file before it kills anything, and the awaitIdle drain below
      // keeps the process alive long enough for that write to land.
      cancelJobs: () => {
        void downloadQueue.stopForShutdown();
      },
      awaitIdle: (timeoutMs) => downloadQueue.waitForIdle(timeoutMs),
      closeSseStreams: closeAllSseStreams,
      stopLibraryWatch,
    });
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();
