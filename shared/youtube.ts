/**
 * The single implementation of "YouTube video id from a URL" used by the
 * server (enqueue/download endpoints) and the Chrome extension (background
 * worker). Both sides used to carry their own copies that disagreed: the
 * server accepted any length, the extension required exactly 11 characters.
 *
 * YouTube video ids are always 11 characters of [A-Za-z0-9_-]; anything else
 * is rejected so an invalid id cannot reach yt-dlp or the queue.
 *
 * Extraction only ever succeeds for real YouTube hosts. This doubles as the
 * server's SSRF guard: a URL on any other host yields null, and callers
 * refuse the request instead of handing the raw URL to yt-dlp (which would
 * happily fetch file:///etc/passwd or http://169.254.169.254/…).
 */

const YOUTUBE_ID_RE = /^[a-zA-Z0-9_-]{11}$/;

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
  'youtu.be',
]);

/** Whether a string is a well-formed 11-character YouTube video id */
export function isYoutubeVideoId(id: string): boolean {
  return YOUTUBE_ID_RE.test(id);
}

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
    if (!YOUTUBE_HOSTS.has(parsed.hostname)) {
      return null;
    }
    const v = parsed.searchParams.get('v');
    if (v) {
      candidate = v;
    } else {
      const segments = parsed.pathname.split('/').filter(Boolean);
      const [first] = segments;
      if (parsed.hostname === 'youtu.be') {
        candidate = first ?? null;
      } else {
        const marker = segments.findIndex(
          (segment) => segment === 'shorts' || segment === 'embed' || segment === 'live' || segment === 'v',
        );
        candidate = (marker >= 0 && segments[marker + 1]) || null;
      }
    }
  } catch {
    return null;
  }
  return candidate !== null && YOUTUBE_ID_RE.test(candidate) ? candidate : null;
}

/** Whether the path segments of a YouTube URL name a channel */
function isChannelPath(segments: string[]): boolean {
  const [first, second] = segments;
  const rest = segments.slice(1);
  if (first === undefined) {
    return true; // bare https://www.youtube.com: yt-dlp resolves the channel
  }
  if (first.startsWith('@') || first === 'feed') {
    // @handle, optionally with a trailing /videos or /featured
    return rest.length === 0 || (rest.length === 1 && (rest[0] === 'videos' || rest[0] === 'featured'));
  }
  const kind = first.toLowerCase();
  if (kind === 'channel' || kind === 'c' || kind === 'user') {
    // /channel/<id>, /c/<name>, /user/<name>, optionally with /videos
    const tail = segments.slice(2);
    return (
      second !== undefined && second.length > 0 && (tail.length === 0 || (tail.length === 1 && tail[0] === 'videos'))
    );
  }
  return false;
}

/**
 * A YouTube channel URL rebuilt from its parsed host and path, or null when
 * the URL is not one. Accepts the canonical shapes: `/@handle`,
 * `/channel/<id>`, `/c/<name>`, `/user/<name>` and the bare host (yt-dlp
 * resolves the channel from the home page). Only `https:` URLs on the
 * allowlisted YouTube hosts pass, which makes this the SSRF guard of the
 * playlist endpoint: yt-dlp would otherwise fetch an arbitrary URL
 * (file:///etc/passwd, http://169.254.169.254/, …).
 *
 * The rebuilt string drops userinfo, port, query and hash, so yt-dlp never
 * receives the configured text itself. A backslash or userinfo is refused
 * outright: that is where this WHATWG parser and yt-dlp's urlsplit part ways,
 * and `https://www.youtube.com\@127.0.0.1:9200` is www.youtube.com here but
 * host 127.0.0.1, port 9200 to Python.
 */
export function toChannelUrl(url: string): string | null {
  if (url.includes('\\')) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || !YOUTUBE_HOSTS.has(parsed.hostname)) {
    return null;
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return null;
  }
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (!isChannelPath(segments)) {
    return null;
  }
  return `https://${parsed.hostname}${segments.map((segment) => `/${segment}`).join('')}`;
}

/** Whether a URL points at a YouTube channel, by the rules of toChannelUrl */
export function isYoutubeChannelUrl(url: string): boolean {
  return toChannelUrl(url) !== null;
}
