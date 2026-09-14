/**
 * The single implementation of "YouTube video id from a URL" used by the
 * server (enqueue/download endpoints) and the Chrome extension (background
 * worker). Both sides used to carry their own copies that disagreed: the
 * server accepted any length, the extension required exactly 11 characters.
 *
 * YouTube video ids are always 11 characters of [A-Za-z0-9_-]; anything else
 * is rejected so an invalid id cannot reach yt-dlp or the queue.
 */

const YOUTUBE_ID_RE = /^[a-zA-Z0-9_-]{11}$/;

/**
 * Canonical watch URL for a video id. Dropping playlist context matters:
 * yt-dlp treats `watch?v=X&list=Y&index=N` as "walk playlist Y starting at
 * X", so a page URL copied from a playlist downloads every following video.
 */
export function toWatchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

/** The 11-character video id from common YouTube URL shapes, or null */
export function extractYoutubeVideoId(url: string): string | null {
  let candidate: string | null;
  try {
    const parsed = new URL(url);
    const v = parsed.searchParams.get('v');
    if (v) {
      candidate = v;
    } else {
      const host = parsed.hostname.replace(/^www\./, '');
      const segments = parsed.pathname.split('/').filter(Boolean);
      const [first] = segments;
      if (host === 'youtu.be' && first) {
        candidate = first;
      } else {
        const marker = segments.findIndex(
          (segment) =>
            segment === 'shorts' || segment === 'embed' || segment === 'live' || segment === 'v'
        );
        candidate = (marker >= 0 && segments[marker + 1]) || null;
      }
    }
  } catch {
    return null;
  }
  return candidate !== null && YOUTUBE_ID_RE.test(candidate) ? candidate : null;
}
