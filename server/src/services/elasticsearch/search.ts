import type { estypes } from '@elastic/elasticsearch';
import type { SortOption, VideoListItem } from '@videodeck/shared/api';
import { SEARCH_DEFAULT_PAGE_SIZE, SEARCH_MAX_RESULT_WINDOW } from '@videodeck/shared/schemas';
import { getVideosFolderPaths } from '../../config';
import { fromDocument, type VideoDocument } from './bulkIndexing';
import { assertElasticsearchReachable, getElasticsearchClient } from './connection';
import { getIndexNameFromFolderPath } from './indexLifecycle';

/**
 * Fields that are search-only and must never leak back into responses:
 * comments and transcripts are indexed as one text blob each.
 */
const SEARCH_ONLY_SOURCE_FIELDS = ['commentsText', 'transcriptText'] as const;

/**
 * Fields the SEARCH response leaves out on top of the search-only blobs:
 * descriptions are full yt-dlp text (MBs across a 500-result page) and
 * nothing in the list UI renders them — the details endpoint serves them.
 */
const SEARCH_EXCLUDED_SOURCE_FIELDS = ['description', 'videoPath', 'subtitlePath', 'likeCount'] as const;

/**
 * Alias names to search: the given folders, or every configured folder.
 *
 * Never called with an empty `folderPaths` array — Elasticsearch reads an
 * empty index list as "all indices", which would silently widen the search
 * instead of narrowing it. Callers filtering by category must short-circuit,
 * and the default (`getVideosFolderPaths()` after glob expansion) may be
 * empty when no drive is mounted — that must fail loudly instead of
 * searching every index.
 */
function getIndexPattern(folderPaths: string[] = getVideosFolderPaths()): string | string[] {
  if (folderPaths.length === 0) {
    throw new Error('No video folders configured — refusing to search across all Elasticsearch indices');
  }
  return folderPaths.map((folderPath) => getIndexNameFromFolderPath(folderPath));
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function buildSortOptions(sortOption: SortOption): estypes.SortCombinations[] {
  switch (sortOption) {
    case 'relevance':
      // No explicit sort: Elasticsearch orders by _score (only meaningful
      // with a query; match_all scores are all equal)
      return [];
    case 'date-desc':
      return [{ uploadDate: { order: 'desc', missing: '_last' } }];
    case 'date-asc':
      return [{ uploadDate: { order: 'asc', missing: '_last' } }];
    case 'views-desc':
      return [{ viewCount: { order: 'desc', missing: '_last' } }];
    case 'views-asc':
      return [{ viewCount: { order: 'asc', missing: '_last' } }];
    case 'likes-desc':
      return [{ likeCount: { order: 'desc', missing: '_last' } }];
    case 'likes-asc':
      return [{ likeCount: { order: 'asc', missing: '_last' } }];
    default:
      return [{ uploadDate: { order: 'desc', missing: '_last' } }];
  }
}

export const SEARCH_FIELDS = ['baseName.text^4', 'title^3', 'description^2', 'transcriptText^2', 'commentsText'];

/** How many results one page holds by default (shared with the client) */
export const SEARCH_DEFAULT_LIMIT = SEARCH_DEFAULT_PAGE_SIZE;
/** Upper bound for ?limit= — keeps response payloads bounded */
export const SEARCH_MAX_LIMIT = 500;

export interface SearchOptions {
  /** First result to return (0-based) */
  offset?: number;
  /** Results per page; clamped to 1..SEARCH_MAX_LIMIT */
  limit?: number;
  /** Exact channel filter (matches channelName.keyword) */
  channel?: string;
}

/** Control chars wrapping highlight fragments — never occur in user content */
const HIGHLIGHT_OPEN = '\u0001';
const HIGHLIGHT_CLOSE = '\u0002';

/**
 * Page start and size for one search, kept inside Elasticsearch's result
 * window. The cluster rejects `from + size > index.max_result_window` with a
 * 400 (search_phase_execution_exception), which reached the user as a 500 on
 * deep pages.
 *
 * A page whose end would cross the window comes back shortened, and an offset
 * at or past it becomes a size-0 query: no hits, but the total still describes
 * the query honestly. The page start is never pulled back to the window edge,
 * because a shifted page would repeat documents the caller already holds and a
 * client appending pages would never reach the end of the list.
 */
function normalizePaging(options: SearchOptions): { from: number; size: number } {
  const from = Math.max(0, Math.trunc(options.offset ?? 0));
  const size = Math.min(SEARCH_MAX_LIMIT, Math.max(1, Math.trunc(options.limit ?? SEARCH_DEFAULT_LIMIT)));
  if (from >= SEARCH_MAX_RESULT_WINDOW) {
    return { from: 0, size: 0 };
  }
  return { from, size: Math.min(size, SEARCH_MAX_RESULT_WINDOW - from) };
}

/**
 * Search videos with query, sorting and paging. `folderPaths` narrows the
 * search to those folders' indices (used by the category filter); an empty
 * array means "no folder qualifies" and yields no results.
 */
export async function searchVideosWithTotal(
  query?: string,
  sortOption: SortOption = 'date-desc',
  folderPaths?: string[],
  options: SearchOptions = {},
): Promise<{ videos: VideoListItem[]; total: number }> {
  if (folderPaths?.length === 0) {
    return { videos: [], total: 0 };
  }
  assertElasticsearchReachable();
  const esClient = getElasticsearchClient();
  const { from, size } = normalizePaging(options);

  let mustQuery: Record<string, unknown> = { match_all: {} };
  const trimmedQuery = query?.trim() ?? '';
  const hasQuery = trimmedQuery.length > 0;

  if (hasQuery) {
    mustQuery = {
      multi_match: {
        query: trimmedQuery,
        fields: SEARCH_FIELDS,
        type: 'best_fields',
        fuzziness: 'AUTO',
      },
    };
  }

  // The channel filter narrows the result set without touching scoring
  const filters: Record<string, unknown>[] = [];
  if (options.channel) {
    filters.push({ term: { 'channelName.keyword': options.channel } });
  }

  // commentsText is search-only; it would dominate the payload otherwise
  const response = await esClient.search<VideoDocument>({
    index: getIndexPattern(folderPaths),
    ignore_unavailable: true,
    query:
      filters.length > 0 ? { bool: { must: [mustQuery], filter: filters } } : hasQuery ? mustQuery : { match_all: {} },
    sort: buildSortOptions(sortOption),
    from,
    size,
    track_total_hits: true,
    _source: {
      excludes: [...SEARCH_ONLY_SOURCE_FIELDS, ...SEARCH_EXCLUDED_SOURCE_FIELDS],
    },
    // Fragments wrap matches in control chars the client turns into <mark>s;
    // never HTML from the server into dangerouslySetInnerHTML.
    ...(hasQuery
      ? {
          highlight: {
            fields: {
              title: { number_of_fragments: 0 },
              description: { fragment_size: 160, number_of_fragments: 1 },
              commentsText: { fragment_size: 160, number_of_fragments: 1 },
              transcriptText: { fragment_size: 160, number_of_fragments: 1 },
            },
            pre_tags: [HIGHLIGHT_OPEN],
            post_tags: [HIGHLIGHT_CLOSE],
          },
        }
      : {}),
  });

  const videos = response.hits.hits.map((hit) => {
    if (!hit._source) {
      throw new Error(`Video document ${hit._id} has no _source field`);
    }
    const video = fromDocument(hit._source);
    const highlights = buildHighlights(hit.highlight);
    return highlights ? { ...video, highlights } : video;
  });

  // The total belongs to the SAME query+filters: a match_all count used to
  // be fetched separately and broke pagination/counters for filtered search.
  const total =
    typeof response.hits.total === 'number' ? response.hits.total : (response.hits.total?.value ?? videos.length);
  return { videos, total };
}

/** Videos-only variant of the search (total dropped) */
export async function searchVideos(
  query?: string,
  sortOption: SortOption = 'date-desc',
  folderPaths?: string[],
  options: SearchOptions = {},
): Promise<VideoListItem[]> {
  return (await searchVideosWithTotal(query, sortOption, folderPaths, options)).videos;
}

/**
 * Shape the ES highlight map into the response contract: `title` and
 * `description` fragments under their own keys, one merged `snippet` from
 * the search-only text fields (comments/transcript) for the result cards.
 */
function buildHighlights(highlight: Record<string, string[]> | undefined): Record<string, string[]> | undefined {
  if (!highlight) {
    return undefined;
  }
  const result: Record<string, string[]> = {};
  for (const field of ['title', 'description']) {
    const fragments = highlight[field];
    if (fragments && fragments.length > 0) {
      result[field] = fragments.slice(0, 3);
    }
  }
  const snippet = [...(highlight.commentsText ?? []), ...(highlight.transcriptText ?? [])];
  if (snippet.length > 0) {
    result.snippet = snippet.slice(0, 2);
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Channel metadata for the UI. One query answers both questions: the distinct
 * names behind the search filter, and which channel each folder holds (a
 * sub-aggregation per folder bucket), so the console can link to the search
 * page with a value the search actually filters by.
 */
export interface ChannelNames {
  /** Distinct channel names across the configured folders, for the filter UI */
  channels: string[];
  /** Folder path to the channel name its videos carry, for the console link */
  folders: Record<string, string>;
}

/** Terms bucket shape of the two aggregations below */
interface TermsBucket {
  key: string;
  channel?: { buckets?: Array<{ key: string }> };
}

/**
 * Channel metadata for the UI. One query answers both questions: the distinct
 * names behind the search filter, and which channel each folder holds (a
 * sub-aggregation per folder bucket), so the console can link to the search
 * page with a value the search actually filters by.
 *
 * Like searchVideos, it skips aliases that do not exist yet: a freshly
 * attached drive adds folders nobody has indexed, and the filter must keep
 * working for the indexed ones instead of failing the whole request.
 */
export async function listChannelNames(): Promise<ChannelNames> {
  assertElasticsearchReachable();
  const esClient = getElasticsearchClient();
  const response = await esClient.search<VideoDocument>({
    index: getIndexPattern(),
    ignore_unavailable: true,
    size: 0,
    aggs: {
      channels: { terms: { field: 'channelName.keyword', size: 200 } },
      folders: {
        terms: { field: 'folderPath.keyword', size: 500 },
        aggs: { channel: { terms: { field: 'channelName.keyword', size: 1 } } },
      },
    },
  });
  const aggregations = response.aggregations as
    | { channels?: { buckets?: TermsBucket[] }; folders?: { buckets?: TermsBucket[] } }
    | undefined;

  const channels = (aggregations?.channels?.buckets ?? [])
    .map((bucket) => bucket.key)
    .sort((a, b) => a.localeCompare(b));

  // A folder whose videos carry no channel name is left out: the console then
  // hides its search link instead of pointing at a filter that matches nothing
  const folders: Record<string, string> = {};
  for (const bucket of aggregations?.folders?.buckets ?? []) {
    const [topChannel] = bucket.channel?.buckets ?? [];
    if (topChannel !== undefined) {
      folders[bucket.key] = topChannel.key;
    }
  }

  return { channels, folders };
}

export async function getAllVideos(sortOption: SortOption = 'date-desc'): Promise<VideoListItem[]> {
  return searchVideos(undefined, sortOption);
}

async function findOne(query: Record<string, unknown>): Promise<VideoListItem | null> {
  assertElasticsearchReachable();
  const esClient = getElasticsearchClient();
  const response = await esClient.search<VideoDocument>({
    index: getIndexPattern(),
    ignore_unavailable: true,
    query,
    size: 1,
    _source: {
      excludes: [...SEARCH_ONLY_SOURCE_FIELDS],
    },
  });
  const hit = response.hits.hits[0];
  return hit?._source ? fromDocument(hit._source) : null;
}

/**
 * Get a single video by videoId (document id) across all folders
 */
export async function getVideoByVideoId(videoId: string): Promise<VideoListItem | null> {
  return findOne({ ids: { values: [videoId] } });
}

/**
 * Get a single video by baseName across all folders
 */
export async function getVideoByBaseName(baseName: string): Promise<VideoListItem | null> {
  return findOne({ term: { baseName } });
}

/**
 * Get a single video by its video or thumbnail file name (exact match across
 * all folders). Used to resolve which folder a requested file lives in.
 */
export async function getVideoByFilePath(fileName: string): Promise<VideoListItem | null> {
  return findOne({
    bool: {
      should: [{ term: { videoPath: fileName } }, { term: { thumbnailPath: fileName } }],
      minimum_should_match: 1,
    },
  });
}
