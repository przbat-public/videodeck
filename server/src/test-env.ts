/**
 * Deterministic defaults for tests that use the application-wide
 * `downloadQueue`: one attempt only, so a failing yt-dlp run errors out
 * immediately instead of scheduling a 30 s retry that would hang SSE tests.
 * The retry behaviour itself is covered by downloadQueue.test.ts with
 * dedicated queue instances.
 */
process.env.DOWNLOAD_MAX_ATTEMPTS = '1';
