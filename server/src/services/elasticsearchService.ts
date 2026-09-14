import { Client } from '@elastic/elasticsearch';
import type { estypes } from '@elastic/elasticsearch';
import type { SortOption, VideoListItem } from '@shared/api';
import { getVideosFolderPaths, ELASTICSEARCH_URL } from '../config';
import { createHash } from 'crypto';
import { logger } from '../utils/logger';

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
 * Never call this with an empty `folderPaths` array — Elasticsearch reads an
 * empty index list as "all indices", which would silently widen the search
 * instead of narrowing it. Callers filtering by category must short-circuit.
 */
function getIndexPattern(folderPaths: string[] = getVideosFolderPaths()): string | string[] {
  return folderPaths.map((folderPath) => getIndexNameFromFolderPath(folderPath));
}

export const getElasticsearchClient = (): Client => {
  if (!client) {
    client = new Client({
      node: ELASTICSEARCH_URL,
    });
  }
  return client;
};

/** Convert a scanned video into the stored document */
export function toDocument(video: VideoListItem): VideoDocument {
  const { comments, ...rest } = video;
  const commentsText = (comments ?? [])
    .map((comment) => comment.text)
    .filter((text): text is string => typeof text === 'string' && text.length > 0)
    .join('\n');
  return commentsText.length > 0 ? { ...rest, commentsText } : rest;
}

/** Convert a stored document back into the API shape */
export function fromDocument(document: VideoDocument): VideoListItem {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { commentsText, ...rest } = document;
  return { ...rest, comments: [] };
}

/**
 * Text analysis for search: Polish stemming plus diacritics folding, so
 * `srodek` finds `środek`, `środka`, `środki`, … without the user having to
 * type diacritics. Indices created before this analyzer existed keep the old
 * `standard` mapping until the next reindex (refreshCache).
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
            filter: ['lowercase', 'asciifolding', 'polish_stop', 'polish_stem'],
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

  await esClient.indices.updateAliases({
    actions: [
      ...previous.map((index) => ({ remove: { index, alias } })),
      { add: { index: indexName, alias } },
    ],
  });

  const stale = new Set([
    ...previous,
    ...(await listAllIndexVersions(folderPath)).filter((name) => name !== indexName),
  ]);
  for (const index of stale) {
    await esClient.indices.delete({ index, ignore_unavailable: true });
    logger.info(`Index ${index} deleted`);
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
 * through the folder aliases.
 */
export async function bulkIndexVideos(
  videos: VideoListItem[],
  options: BulkIndexOptions = {}
): Promise<void> {
  if (videos.length === 0) {
    return;
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

  for (const [indexName, group] of targets) {
    await bulkIndexDocuments(indexName, group.map(toDocument), refresh);
  }
}

/**
 * Write already-flattened documents into one index with a single `_bulk`
 * request. Callers are responsible for keeping the batch under
 * Elasticsearch's `http.max_content_length` (100 MB by default).
 */
export async function bulkIndexDocuments(
  indexName: string,
  documents: VideoDocument[],
  refresh = true
): Promise<void> {
  if (documents.length === 0) {
    return;
  }
  const esClient = getElasticsearchClient();

  const operations = documents.flatMap((document) => [
    { index: { _index: indexName, _id: document.videoId || document.baseName } },
    document,
  ]);

  const response = await esClient.bulk({ operations });

  if (response.errors) {
    const errors = response.items
      .filter((item) => item.index?.error)
      .map((item) => `${item.index?._id}: ${item.index?.error?.reason ?? 'unknown error'}`);
    logger.error(`${errors.length} videos failed to index in ${indexName}:`, errors.slice(0, 5));
    throw new Error(`Bulk indexing failed for ${errors.length} of ${documents.length} videos`);
  }

  if (refresh) {
    await esClient.indices.refresh({ index: indexName });
  }
}

/**
 * Rough size of the serialized document — used to keep bulk requests small
 * without serializing twice.
 */
export function estimateDocumentBytes(document: VideoDocument): number {
  return (
    (document.commentsText?.length ?? 0) +
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

export const SEARCH_FIELDS = ['baseName.text^4', 'title^3', 'description^2', 'commentsText'];

/** How many results one page holds by default */
export const SEARCH_DEFAULT_LIMIT = 100;
/** Upper bound for ?limit= — keeps response payloads bounded */
export const SEARCH_MAX_LIMIT = 500;

export interface SearchOptions {
  /** First result to return (0-based) */
  offset?: number;
  /** Results per page; clamped to 1..SEARCH_MAX_LIMIT */
  limit?: number;
}

function normalizePaging(options: SearchOptions): { from: number; size: number } {
  const from = Math.max(0, Math.trunc(options.offset ?? 0));
  const size = Math.min(
    SEARCH_MAX_LIMIT,
    Math.max(1, Math.trunc(options.limit ?? SEARCH_DEFAULT_LIMIT))
  );
  return { from, size };
}

/**
 * Search videos with query, sorting and paging. `folderPaths` narrows the
 * search to those folders' indices (used by the category filter); an empty
 * array means "no folder qualifies" and yields no results.
 */
export async function searchVideos(
  query?: string,
  sortOption: SortOption = 'date-desc',
  folderPaths?: string[],
  options: SearchOptions = {}
): Promise<VideoListItem[]> {
  if (folderPaths?.length === 0) {
    return [];
  }
  const esClient = getElasticsearchClient();
  const { from, size } = normalizePaging(options);

  let searchQuery: Record<string, unknown> = { match_all: {} };

  if (query && query.trim().length > 0) {
    searchQuery = {
      multi_match: {
        query: query.trim(),
        fields: SEARCH_FIELDS,
        type: 'best_fields',
        fuzziness: 'AUTO',
      },
    };
  }

  // commentsText is search-only; it would dominate the payload otherwise
  const response = await esClient.search<VideoDocument>({
    index: getIndexPattern(folderPaths),
    ignore_unavailable: true,
    query: searchQuery,
    sort: buildSortOptions(sortOption),
    from,
    size,
    _source: {
      excludes: ['commentsText'],
    },
  });

  return response.hits.hits.map((hit) => {
    if (!hit._source) {
      throw new Error(`Video document ${hit._id} has no _source field`);
    }
    return fromDocument(hit._source);
  });
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
      excludes: ['commentsText'],
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

/** Documents indexed for the given folders, or for all of them */
export async function getTotalVideoCount(folderPaths?: string[]): Promise<number> {
  if (folderPaths?.length === 0) {
    return 0;
  }
  const esClient = getElasticsearchClient();

  const response = await esClient.count({
    index: getIndexPattern(folderPaths),
    ignore_unavailable: true,
    query: {
      match_all: {},
    },
  });

  return response.count;
}

export async function checkElasticsearchConnection(): Promise<boolean> {
  try {
    const esClient = getElasticsearchClient();
    await esClient.ping();
    return true;
  } catch (error) {
    logger.error('Elasticsearch connection failed:', error);
    return false;
  }
}
