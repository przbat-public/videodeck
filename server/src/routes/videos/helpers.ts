import type { SortOption, VideoListItem } from '@videodeck/shared/api';
import { getVideoByBaseName, getVideoByVideoId } from '../../services/elasticsearchService';

/**
 * Request parsing shared by the video read handlers.
 *
 * Query values come from the network, so every parser takes `unknown` (or a
 * raw query value) and falls back to its default instead of failing the
 * request. The offset cap is the one hard limit: Elasticsearch refuses
 * `from + size > 10000`, so a huge offset would turn into a 500.
 */

export const SORT_OPTIONS: readonly SortOption[] = [
  'relevance',
  'date-desc',
  'date-asc',
  'views-desc',
  'views-asc',
  'likes-desc',
  'likes-asc',
];

function isSortOption(value: string): value is SortOption {
  return (SORT_OPTIONS as readonly string[]).includes(value);
}

/** `?sort=` value; unknown or missing values fall back to the default */
export function parseSortOption(value: unknown): SortOption {
  return typeof value === 'string' && isSortOption(value) ? value : 'date-desc';
}

/** `?offset=`/`?limit=` values; anything malformed falls back to the default */
export function parseNonNegativeInt(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * Hard cap for `?offset=`: beyond this Elasticsearch dies on
 * `max_result_window` (from+size > 10000) and every request becomes a 500.
 */
const MAX_OFFSET = 10_000;

/** `?offset=` for search/comments: clamped so a huge offset cannot 500 ES */
export function parseOffset(value: string | undefined): number {
  return Math.min(parseNonNegativeInt(value, 0), MAX_OFFSET);
}

const YOUTUBE_ID_RE = /^[a-zA-Z0-9_-]{11}$/;

/**
 * Look a video up by YouTube id (when the identifier looks like one) and
 * fall back to the file base name.
 */
export async function findVideo(identifier: string): Promise<VideoListItem | null> {
  const byId = YOUTUBE_ID_RE.test(identifier) ? await getVideoByVideoId(identifier) : null;
  return byId ?? getVideoByBaseName(identifier);
}
