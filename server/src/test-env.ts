import os from 'node:os';
import path from 'node:path';

/**
 * Deterministic defaults for tests that use the application-wide
 * `downloadQueue`: one attempt only, so a failing yt-dlp run errors out
 * immediately instead of scheduling a 30 s retry that would hang SSE tests.
 * The retry behaviour itself is covered by downloadQueue.test.ts with
 * dedicated queue instances.
 */
process.env.DOWNLOAD_MAX_ATTEMPTS = '1';

/**
 * The queue persists to `.queue-state.json` relative to the working directory,
 * which in a test run is the real `server/` directory. A suite that enqueues,
 * clears or pauses the application-wide queue then rewrites the state file of a
 * dev server running in the same checkout: that is how a live queue lost its
 * pending jobs and came back paused. The temporary path carries the process id,
 * so two suites running side by side keep their own state as well.
 *
 * The deep integration environment points this at its temp root too, for the
 * same reason (test-infra/src/deepServerTestEnv.ts).
 */
process.env.QUEUE_STATE_FILE = path.join(os.tmpdir(), `videodeck-queue-state-${process.pid}.json`);
