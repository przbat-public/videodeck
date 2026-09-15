import { createHash } from 'node:crypto';
import type { estypes } from '@elastic/elasticsearch';
import { Client } from '@elastic/elasticsearch';
import type { SortOption, VideoListItem } from '@shared/api';
import { SEARCH_DEFAULT_PAGE_SIZE } from '@shared/schemas';
import { ELASTICSEARCH_URL, getVideosFolderPaths } from '../config';
import { logger } from '../utils/logger';
import { runPool } from '../utils/runPool';

/**
 * Index layout
 *
 * Every folder is searched through an alias `videos_<hash>` that points at
 * exactly one physical index `videos_<hash>_<timestamp>`. A reindex writes
 * into a brand-new physical index and swaps the alias atomically when it is
 * done, so search keeps working during the (long) scan and a crash half-way
 * leaves the previous index untouched.
 *
 * Comments are stored as one `commentsText` field for full-text search only;
 * the comment tree is read from `.info.json` on demand by the details endpoint.
 */

const INDEX_PREFIX = 'videos';

/** Shape of a document stored in Elasticsearch */
export type VideoDocument = Omit<VideoListItem, 'comments'> & {
  commentsText?: string;
};

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

let client: Client | null = null;

/**
 * Alias name for a folder (stable, derived from the folder path)
 */
export function getIndexNameFromFolderPath(folderPath: string): string {
  const hash = createHash('sha256').update(folderPath).digest('hex').substring(0, 16);
  return `${INDEX_PREFIX}_${hash}`;
}

/**
 * Name for a new physical index behind the folder alias
 */
export function buildIndexVersionName(folderPath: string, now: Date = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/[-:.TZ]/g, '')
    .slice(0, 17);
  return `${getIndexNameFromFolderPath(folderPath)}_${stamp}`;
}

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

export const getElasticsearchClient = (): Client => {
  if (!client) {
    client = new Client({
      node: ELASTICSEARCH_URL,
      // Elasticsearch hiccups happen (GC pauses, container restarts) — the
      // official client retries transient failures instead of failing the
      // request immediately
      maxRetries: 3,
      requestTimeout: 30_000,
    });
  }
  return client;
};

let probeClient: Client | null = null;

/**
 * A separate client for health probes and quick alias checks: short timeout,
 * no retries. The regular client retries for up to 2 minutes per call, which
 * would hang /health and /api/status for minutes when Elasticsearch is
 * unreachable-but-not-refused.
 */
export function getProbeClient(): Client {
  if (!probeClient) {
    probeClient = new Client({
      node: ELASTICSEARCH_URL,
      maxRetries: 0,
      requestTimeout: 3_000,
    });
  }
  return probeClient;
}

/**
 * Injection point: replace the client (tests, custom transport setup). Pass
 * null to fall back to the lazy defaults built from ELASTICSEARCH_URL. Both
 * accessors return the override — the probe client shares the same mock in
 * tests, in production each lazy accessor builds its own.
 */
export function setElasticsearchClient(override: Client | null): void {
  client = override;
  probeClient = override;
}

/** Convert a scanned video into the stored document */
export function toDocument(video: VideoListItem): VideoDocument {
  const { comments, ...rest } = video;
  const commentsText = (comments ?? [])
    .map((comment) => comment.text)
    .filter((text): text is string => typeof text === 'string' && text.length > 0)
    .join('\n');
  const document: VideoDocument = commentsText.length > 0 ? { ...rest, commentsText } : rest;
  // yt-dlp writes counts as numbers, but a hand-edited info.json can carry
  // strings — one such document used to fail the whole bulk (mapping
  // conflict with `integer`) and sink the entire folder's reindex.
  const viewCount = coerceInteger(document.viewCount);
  if (viewCount !== undefined) {
    document.viewCount = viewCount;
  } else {
    delete document.viewCount;
  }
  const likeCount = coerceInteger(document.likeCount);
  if (likeCount !== undefined) {
    document.likeCount = likeCount;
  } else {
    delete document.likeCount;
  }
  return document;
}

/** A non-negative integer, or undefined when the value is not a plausible count */
function coerceInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value);
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** Convert a stored document back into the API shape */
export function fromDocument(document: VideoDocument): VideoListItem {
  // Search-only blobs never leave the server; the (always empty) comments
  // array is not emitted either — it was pure payload bloat.
  const { commentsText, transcriptText, ...rest } = document;
  return rest;
}

/**
 * Text analysis for search: diacritics folding, so `srodek` finds `środek`
 * and `ŚRODEK` without the user typing diacritics. Polish stemming/stopwords
 * would need the `analysis-stempel` plugin (not in the stock docker image),
 * so this analyzer sticks to built-in components only; indices created before
 * it existed keep the old `standard` mapping until the next reindex.
 */
const SEARCH_ANALYZER = 'polish_folded';

const INDEX_MAPPINGS = {
  properties: {
    baseName: {
      type: 'keyword',
      fields: {
        // analyzed variant for full-text search (baseName^4 in SEARCH_FIELDS);
        // the keyword parent keeps exact lookups (getVideoByBaseName) working
        text: { type: 'text', analyzer: SEARCH_ANALYZER },
      },
    },
    videoId: { type: 'keyword' },
    title: {
      type: 'text',
      analyzer: SEARCH_ANALYZER,
      fields: {
        keyword: { type: 'keyword' },
      },
    },
    description: {
      type: 'text',
      analyzer: SEARCH_ANALYZER,
    },
    videoPath: { type: 'keyword' },
    thumbnailPath: { type: 'keyword' },
    subtitlePath: { type: 'keyword' },
    folderPath: { type: 'keyword' },
    uploadDate: { type: 'keyword' },
    viewCount: { type: 'integer' },
    likeCount: { type: 'integer' },
    channelName: {
      type: 'text',
      fields: {
        keyword: { type: 'keyword' },
      },
    },
    commentsText: {
      type: 'text',
      analyzer: SEARCH_ANALYZER,
    },
    transcriptText: {
      type: 'text',
      analyzer: SEARCH_ANALYZER,
    },
  },
} as const;

// ---------------------------------------------------------------------------
// Index versions and aliases
// ---------------------------------------------------------------------------

/**
 * Create a fresh, empty physical index for the folder (not yet visible
 * through the alias). Returns its name.
 */
export async function createIndexVersion(folderPath: string): Promise<string> {
  const esClient = getElasticsearchClient();
  const indexName = buildIndexVersionName(folderPath);

  await esClient.indices.create({
    index: indexName,
    settings: {
      index: {
        number_of_replicas: 0,
      },
      analysis: {
        analyzer: {
          [SEARCH_ANALYZER]: {
            type: 'custom',
            tokenizer: 'standard',
            filter: ['lowercase', 'asciifolding'],
          },
        },
      },
    },
    mappings: INDEX_MAPPINGS,
  });

  logger.info(`Index ${indexName} created for folder: ${folderPath}`);
  return indexName;
}

/**
 * Physical indices currently behind the folder alias (empty when none).
 */
export async function getIndexVersions(folderPath: string): Promise<string[]> {
  const esClient = getElasticsearchClient();
  const alias = getIndexNameFromFolderPath(folderPath);
  try {
    const response = await esClient.indices.getAlias({ name: alias });
    return Object.keys(response);
  } catch (error) {
    if ((error as { meta?: { statusCode?: number } }).meta?.statusCode === 404) {
      return [];
    }
    throw error;
  }
}

/**
 * Every physical index created for the folder — behind the alias or orphaned
 * by a reindex that died before promoting/discarding it.
 */
export async function listAllIndexVersions(folderPath: string): Promise<string[]> {
  const esClient = getElasticsearchClient();
  const response = await esClient.indices.get({
    index: `${getIndexNameFromFolderPath(folderPath)}_*`,
    ignore_unavailable: true,
    allow_no_indices: true,
    features: ['aliases'],
  });
  return Object.keys(response);
}

/** Alias checks that run in parallel without hammering Elasticsearch */
const CACHE_CHECK_CONCURRENCY = 8;

/**
 * Which of the given folders already have a search cache in Elasticsearch
 * (their alias exists). Aliases are named after folder paths and persist in
 * ES independently of the disks, so after a disk swap this tells which of
 * the currently mounted folders can be searched right away — a reindex is
 * only needed for the rest.
 *
 * A folder whose check fails (ES down mid-request) counts as uncached: the
 * status page should never 500 because of one hiccup.
 */
export async function listCachedFolders(folderPaths: string[]): Promise<Set<string>> {
  const cached = new Set<string>();
  await runPool(folderPaths, CACHE_CHECK_CONCURRENCY, async (folderPath) => {
    const alias = getIndexNameFromFolderPath(folderPath);
    try {
      const exists = await getProbeClient().indices.existsAlias({ name: alias });
      if (exists) {
        cached.add(folderPath);
      }
    } catch (error) {
      logger.warn(
        `Cannot check the index cache of ${folderPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });
  return cached;
}

/**
 * Point the folder alias at `indexName` and drop every other physical index
 * of the folder (the previous version and any orphans). Also migrates the
 * legacy layout where a concrete index carried the alias name.
 */
export async function promoteIndexVersion(folderPath: string, indexName: string): Promise<void> {
  const esClient = getElasticsearchClient();
  const alias = getIndexNameFromFolderPath(folderPath);

  await esClient.indices.refresh({ index: indexName });

  const previous = (await getIndexVersions(folderPath)).filter((name) => name !== indexName);

  const legacyIndexExists =
    previous.length === 0 &&
    (await esClient.indices.exists({ index: alias })) &&
    !(await esClient.indices.existsAlias({ name: alias }));
  if (legacyIndexExists) {
    logger.info(`Removing legacy index ${alias} to make room for the alias`);
    await esClient.indices.delete({ index: alias });
  }

  // Everything before this line may fail and leave the old index untouched;
  // everything after the swap is best-effort cleanup that must never throw —
  // an exception here used to propagate to scanFolder, which then discarded
  // the index that was ALREADY the alias target (silent empty search results).
  await esClient.indices.updateAliases({
    actions: [...previous.map((index) => ({ remove: { index, alias } })), { add: { index: indexName, alias } }],
  });

  const stale = new Set([
    ...previous,
    ...(await listAllIndexVersions(folderPath)).filter((name) => name !== indexName),
  ]);
  for (const index of stale) {
    try {
      await esClient.indices.delete({ index, ignore_unavailable: true });
      logger.info(`Index ${index} deleted`);
    } catch (error) {
      // Best-effort: an orphaned index is dead weight, never a correctness
      // problem — the next successful reindex sweeps it again.
      logger.warn(`Cannot delete stale index ${index}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  logger.info(`Alias ${alias} now points at ${indexName} for folder: ${folderPath}`);
}

/**
 * Delete a physical index that never got promoted (failed reindex).
 */
export async function discardIndexVersion(indexName: string): Promise<void> {
  const esClient = getElasticsearchClient();
  await esClient.indices.delete({ index: indexName, ignore_unavailable: true });
  logger.info(`Index ${indexName} discarded`);
}

/**
 * Make sure the folder has a searchable (possibly empty) index behind its
 * alias. No-op when the alias already exists.
 */
export async function createIndex(folderPath: string): Promise<void> {
  const esClient = getElasticsearchClient();
  const alias = getIndexNameFromFolderPath(folderPath);

  if (await esClient.indices.existsAlias({ name: alias })) {
    return;
  }

  const indexName = await createIndexVersion(folderPath);
  await promoteIndexVersion(folderPath, indexName);
}

export async function createAllIndices(): Promise<void> {
  for (const folderPath of getVideosFolderPaths()) {
    await createIndex(folderPath);
  }
}

/**
 * Drop the folder's alias and every physical index behind it (including a
 * legacy concrete index with the alias name).
 */
export async function deleteIndex(folderPath: string): Promise<void> {
  const esClient = getElasticsearchClient();
  const alias = getIndexNameFromFolderPath(folderPath);

  const versions = await getIndexVersions(folderPath);
  for (const index of versions) {
    await esClient.indices.delete({ index, ignore_unavailable: true });
    logger.info(`Index ${index} deleted`);
  }
  if (versions.length === 0 && (await esClient.indices.exists({ index: alias }))) {
    await esClient.indices.delete({ index: alias });
    logger.info(`Legacy index ${alias} deleted`);
  }
}

/**
 * Replace the folder's index with a fresh empty one (current mapping).
 * Documents are lost — run a reindex afterwards.
 */
export async function recreateIndex(folderPath: string): Promise<void> {
  const indexName = await createIndexVersion(folderPath);
  await promoteIndexVersion(folderPath, indexName);
  logger.info(`Index recreated for folder: ${folderPath}`);
}

export async function deleteAllIndices(): Promise<void> {
  for (const folderPath of getVideosFolderPaths()) {
    await deleteIndex(folderPath);
  }
}

export async function recreateAllIndices(): Promise<void> {
  for (const folderPath of getVideosFolderPaths()) {
    await recreateIndex(folderPath);
  }
}

// ---------------------------------------------------------------------------
// Writing documents
// ---------------------------------------------------------------------------

export interface BulkIndexOptions {
  /** Physical index to write into; defaults to each video's folder alias */
  index?: string;
  /** Refresh the target after writing (default true) */
  refresh?: boolean;
}

/**
 * Index a single video through its folder alias (upsert by video id).
 */
export async function indexVideo(video: VideoListItem): Promise<void> {
  const esClient = getElasticsearchClient();
  await createIndex(video.folderPath);

  await esClient.index({
    index: getIndexNameFromFolderPath(video.folderPath),
    id: video.videoId || video.baseName,
    document: toDocument(video),
    refresh: true,
  });
}

/**
 * Bulk index videos. With `options.index` everything goes into that physical
 * index (used by reindex); otherwise videos are grouped by folder and written
 * through the folder aliases. Returns how many documents were indexed and
 * how many per-item failures were skipped.
 */
export async function bulkIndexVideos(
  videos: VideoListItem[],
  options: BulkIndexOptions = {},
): Promise<{ indexed: number; skipped: number }> {
  if (videos.length === 0) {
    return { indexed: 0, skipped: 0 };
  }
  const refresh = options.refresh ?? true;

  const targets = new Map<string, VideoListItem[]>();
  if (options.index) {
    targets.set(options.index, videos);
  } else {
    for (const video of videos) {
      const indexName = getIndexNameFromFolderPath(video.folderPath);
      const group = targets.get(indexName) || [];
      group.push(video);
      targets.set(indexName, group);
    }
    for (const video of videos) {
      await createIndex(video.folderPath);
    }
  }

  let indexed = 0;
  let skipped = 0;
  for (const [indexName, group] of targets) {
    const result = await bulkIndexDocuments(indexName, group.map(toDocument), refresh);
    indexed += result.indexed;
    skipped += result.skipped;
  }
  return { indexed, skipped };
}

/**
 * Write already-flattened documents into one index with a single `_bulk`
 * request. Callers are responsible for keeping the batch under
 * Elasticsearch's `http.max_content_length` (100 MB by default).
 *
 * Per-item failures are skipped (counted and logged), so one malformed
 * document no longer sinks the whole folder's reindex. Only when EVERY
 * document fails (e.g. a real mapping conflict) does this throw — promoting
 * an empty index over a good one would silently empty the search results.
 */
export async function bulkIndexDocuments(
  indexName: string,
  documents: VideoDocument[],
  refresh = true,
): Promise<{ indexed: number; skipped: number }> {
  if (documents.length === 0) {
    return { indexed: 0, skipped: 0 };
  }
  const esClient = getElasticsearchClient();

  const operations = documents.flatMap((document) => [
    { index: { _index: indexName, _id: document.videoId || document.baseName } },
    document,
  ]);

  const response = await esClient.bulk({ operations });

  if (response.errors) {
    const failedIds = new Set(
      response.items
        .filter((item) => item.index?.error)
        .map((item) => item.index?._id)
        .filter((id): id is string => typeof id === 'string'),
    );
    if (failedIds.size === documents.length) {
      throw new Error(`Bulk indexing failed for all ${documents.length} videos in ${indexName}`);
    }
    logger.error(`${failedIds.size} videos failed to index in ${indexName} (skipped):`, [...failedIds].slice(0, 5));
    if (refresh) {
      await esClient.indices.refresh({ index: indexName });
    }
    return { indexed: documents.length - failedIds.size, skipped: failedIds.size };
  }

  if (refresh) {
    await esClient.indices.refresh({ index: indexName });
  }
  return { indexed: documents.length, skipped: 0 };
}

/**
 * Rough size of the serialized document — used to keep bulk requests small
 * without serializing twice.
 */
export function estimateDocumentBytes(document: VideoDocument): number {
  return (
    (document.commentsText?.length ?? 0) +
    (document.transcriptText?.length ?? 0) +
    (document.description?.length ?? 0) +
    (document.title?.length ?? 0) +
    512
  );
}

export async function deleteAllVideosFromFolder(folderPath: string): Promise<void> {
  const esClient = getElasticsearchClient();
  const indexName = getIndexNameFromFolderPath(folderPath);

  await esClient.deleteByQuery({
    index: indexName,
    query: {
      match_all: {},
    },
  });

  await esClient.indices.refresh({ index: indexName });
}

export async function deleteAllVideos(): Promise<void> {
  for (const folderPath of getVideosFolderPaths()) {
    await deleteAllVideosFromFolder(folderPath);
  }
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
  /** Upload-date range as yyyyMMdd (inclusive bounds) */
  dateFrom?: string;
  dateTo?: string;
}

/** Control chars wrapping highlight fragments — never occur in user content */
const HIGHLIGHT_OPEN = '\u0001';
const HIGHLIGHT_CLOSE = '\u0002';

function normalizePaging(options: SearchOptions): { from: number; size: number } {
  const from = Math.max(0, Math.trunc(options.offset ?? 0));
  const size = Math.min(SEARCH_MAX_LIMIT, Math.max(1, Math.trunc(options.limit ?? SEARCH_DEFAULT_LIMIT)));
  return { from, size };
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

  // Channel and date filters narrow the result set without touching scoring
  const filters: Record<string, unknown>[] = [];
  if (options.channel) {
    filters.push({ term: { 'channelName.keyword': options.channel } });
  }
  if (options.dateFrom) {
    filters.push({ range: { uploadDate: { gte: options.dateFrom } } });
  }
  if (options.dateTo) {
    filters.push({ range: { uploadDate: { lte: options.dateTo } } });
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

/** Distinct channel names across the configured folders (for the filter UI) */
export async function listChannelNames(): Promise<string[]> {
  const esClient = getElasticsearchClient();
  const response = await esClient.search<VideoDocument>({
    index: getIndexPattern(),
    size: 0,
    aggs: { channels: { terms: { field: 'channelName.keyword', size: 200 } } },
  });
  const buckets = (response.aggregations?.channels as { buckets?: Array<{ key: string }> } | undefined)?.buckets;
  return (buckets ?? []).map((bucket) => bucket.key).sort((a, b) => a.localeCompare(b));
}

export async function getAllVideos(sortOption: SortOption = 'date-desc'): Promise<VideoListItem[]> {
  return searchVideos(undefined, sortOption);
}

async function findOne(query: Record<string, unknown>): Promise<VideoListItem | null> {
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

export async function refreshIndex(folderPath: string): Promise<void> {
  const esClient = getElasticsearchClient();
  await esClient.indices.refresh({ index: getIndexNameFromFolderPath(folderPath) });
}

export async function checkElasticsearchConnection(): Promise<boolean> {
  try {
    await getProbeClient().ping();
    return true;
  } catch (error) {
    logger.error('Elasticsearch connection failed:', error);
    return false;
  }
}

/**
 * Delete physical index versions that are not behind their folder alias —
 * orphans left by a reindex that crashed mid-way (cleanup normally lives in
 * promoteIndexVersion). Runs at startup; failures are logged, never thrown,
 * because ES may simply be down at boot.
 */
export async function sweepOrphanIndexVersions(folderPaths: string[] = getVideosFolderPaths()): Promise<void> {
  for (const folderPath of folderPaths) {
    try {
      const aliasTargets = new Set(await getIndexVersions(folderPath));
      const all = await listAllIndexVersions(folderPath);
      for (const index of all) {
        if (!aliasTargets.has(index)) {
          await deleteIndexBestEffort(index);
        }
      }
    } catch (error) {
      logger.warn(`Cannot sweep orphans of ${folderPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** Delete an orphan index, logging either way — cleanup must never throw */
async function deleteIndexBestEffort(index: string): Promise<void> {
  try {
    await getElasticsearchClient().indices.delete({ index, ignore_unavailable: true });
    logger.info(`Swept orphan index ${index}`);
  } catch (error) {
    logger.warn(`Cannot delete orphan index ${index}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Log a warning for indices whose mapping predates the current analyzer
 * (they keep the old `standard` search behavior until a manual reindex).
 */
export async function warnOnLegacyMappings(folderPaths: string[] = getVideosFolderPaths()): Promise<void> {
  for (const folderPath of folderPaths) {
    try {
      const alias = getIndexNameFromFolderPath(folderPath);
      const mapping = await getProbeClient().indices.getMapping({ index: alias, ignore_unavailable: true });
      const indexMapping = mapping[Object.keys(mapping)[0] ?? ''];
      const analyzer = (indexMapping?.mappings?.properties?.title as { analyzer?: string } | undefined)?.analyzer;
      if (analyzer !== undefined && analyzer !== SEARCH_ANALYZER) {
        logger.warn(
          `Folder ${folderPath}: index mapping uses analyzer "${analyzer}" — reindex to switch to "${SEARCH_ANALYZER}"`,
        );
      }
    } catch {
      // ES down at boot — the warning is cosmetic, nothing to do here
    }
  }
}
