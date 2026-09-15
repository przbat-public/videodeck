import { extractYtDlpProgress } from '@videodeck/shared/progress';

/**
 * The extension used to own its own copy of the progress regex; the logic now
 * lives in shared/progress.ts (used by the server's download queue too), so
 * both sides parse yt-dlp output identically. Re-exported under the old name
 * for the background worker.
 */
export const extractProgress = extractYtDlpProgress;
