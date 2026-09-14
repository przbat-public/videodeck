import { extractYoutubeVideoId } from '@shared/youtube';

/**
 * The extension used to own its own regex copy of the YouTube-id extraction;
 * the logic now lives in shared/youtube.ts (used by the server's folder
 * routes too), so both sides parse URLs identically — including the
 * 11-character id check. Re-exported under the old name for the background
 * worker.
 */
export const getYouTubeVideoId = extractYoutubeVideoId;
