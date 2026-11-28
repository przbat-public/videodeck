import type { estypes } from '@elastic/elasticsearch';
import type { SortOption, VideoListItem } from '@videodeck/shared/api';
import { SEARCH_DEFAULT_PAGE_SIZE, SEARCH_MAX_RESULT_WINDOW, VideoListItemSchema } from '@videodeck/shared/schemas';
import { defaultSortFor } from '@videodeck/shared/search';
import { extractYoutubeVideoId, isYoutubeVideoId } from '@videodeck/shared/youtube';
import { getVideosFolderPaths } from '../../config';
import { logger } from '../../utils/logger';
import { findConfiguredFolder } from '../../utils/videoPathUtils';
import { isSafeVideoStem } from '../../utils/videoStem';
import { isOwnSubtitleName } from '../../utils/vttUtils';
import { ElasticsearchUnavailableError } from '../elasticsearchErrors';
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
function getIndexPattern(folderPaths: string[] = getVideosFolderPaths()): string[] {
  if (folderPaths.length === 0) {
    throw new Error('No video folders configured — refusing to search across all Elasticsearch indices');
  }
  return folderPaths.map((folderPath) => getIndexNameFromFolderPath(folderPath));
}

/**
 * Run one search over the given aliases, through _msearch.
 *
 * A read names the alias of every folder it covers, and in a _search URL that
 * list costs 26 bytes a folder: from 156 folders on, the request line passed
 * the 4 KB Elasticsearch accepts (`http.max_initial_line_length`, a static
 * setting) and every read answered 500. An _msearch header carries the list in
 * the request body, so the line stays `POST /_msearch` whatever the folder
 * count, and `ignore_unavailable` keeps applying per search, the way it did in
 * the URL.
 */
async function searchAliases<TDocument>(
  index: string[],
  body: estypes.SearchSearchRequestBody,
  header: SearchHeader = {},
  signal?: AbortSignal,
): Promise<estypes.MsearchMultiSearchItem<TDocument>> {
  const response = await getElasticsearchClient().msearch<TDocument>(
    { searches: [{ index, ignore_unavailable: true, ...header }, body] },
    // An aborted signal makes the transport drop the connection, and the
    // cluster cancels a search whose connection closed
    signal ? { signal } : undefined,
  );
  return unwrapSearchResponse(response.responses[0]);
}

/** The _msearch header settings a read may add to its alias list */
type SearchHeader = Omit<estypes.MsearchMultisearchHeader, 'index' | 'ignore_unavailable'>;

/**
 * The answer of a one-search _msearch. A search the cluster could not run
 * comes back as an error item inside a 200, where _search threw instead. A 503
 * item, a cluster with no shard ready yet, is still the outage it was, so the
 * banner and the fail-fast window see it; any other error fails the read with
 * the cluster's own reason in its message.
 */
function unwrapSearchResponse<TDocument>(
  item: estypes.MsearchResponseItem<TDocument> | undefined,
): estypes.MsearchMultiSearchItem<TDocument> {
  if (item === undefined) {
    throw new Error('Elasticsearch answered the search without a response');
  }
  if (!('error' in item)) {
    warnOnPartialAnswer(item._shards);
    return item;
  }
  const rootCause = item.error.root_cause?.[0];
  const reason =
    `${item.status} ${item.error.type}: ${item.error.reason ?? 'no reason given'}` +
    (rootCause ? ` (${rootCause.type}: ${rootCause.reason ?? 'no reason given'})` : '');
  if (item.status === 503) {
    throw new ElasticsearchUnavailableError(`Elasticsearch could not run the search: ${reason}`);
  }
  throw new Error(`Elasticsearch refused the search: ${reason}`);
}

/** How many distinct shard failures one warning names */
const MAX_LOGGED_SHARD_FAILURES = 5;

/**
 * A read that some folder could not answer comes back without that folder's
 * hits: a red index, a shard still recovering after a restart, or the old
 * version a reindex deletes right after its alias swap. Refusing the page
 * would put the outage banner and the fail-fast window over the whole library
 * while the cluster answers, so the page is served and the log names what is
 * missing. The highlight cap keeps the one failure every page used to hit
 * (a long comment field) from happening at all.
 */
function warnOnPartialAnswer(shards: estypes.ShardStatistics | undefined): void {
  if (shards === undefined || shards.failed === 0) {
    return;
  }
  const failures = [
    ...new Set((shards.failures ?? []).map((failure) => `${failure.index ?? 'unknown index'}: ${failure.reason.type}`)),
  ];
  logger.warn(
    `Elasticsearch answered a search without ${shards.failed} of ${shards.total} folder shards: ` +
      (failures.slice(0, MAX_LOGGED_SHARD_FAILURES).join('; ') || 'no reason given'),
  );
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
    // Views are long now, and an index built while they were integer stays
    // until a full reindex: read both as long, so one sort spans every folder
    case 'views-desc':
      return [{ viewCount: { order: 'desc', missing: '_last', numeric_type: 'long' } }];
    case 'views-asc':
      return [{ viewCount: { order: 'asc', missing: '_last', numeric_type: 'long' } }];
    case 'likes-desc':
      return [{ likeCount: { order: 'desc', missing: '_last' } }];
    case 'likes-asc':
      return [{ likeCount: { order: 'asc', missing: '_last' } }];
    default:
      return [{ uploadDate: { order: 'desc', missing: '_last' } }];
  }
}

/**
 * The fields a phrase is matched against, with their boosts. The file name is
 * not one of them: under the standard tokenizer a `<date>_<title>_<id>` stem
 * written with --restrict-filenames is a single token no phrase matches, while
 * a file named outside the app splits into words that outscored the title at
 * ^4. The title carries those words, and a video without one gets its stem's.
 */
export const SEARCH_FIELDS = ['title^3', 'description^2', 'transcriptText^2', 'commentsText'];

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
  /** Aborts the Elasticsearch request, e.g. once the HTTP client that asked went away */
  signal?: AbortSignal;
}

/** Control chars wrapping highlight fragments — never occur in user content */
const HIGHLIGHT_OPEN = '\u0001';
const HIGHLIGHT_CLOSE = '\u0002';

/**
 * How many characters of one field the highlighter reads. Uncapped, a field
 * past the index's `index.highlight.max_analyzed_offset` (1,000,000 by
 * default) failed the fetch of its whole shard, so one video with an enormous
 * comment section took its folder's other hits off the page, or failed the
 * search when that folder was all it covered. A cap at or below the index
 * limit truncates instead: a match further in still returns the video, only
 * without a snippet. 100,000 matches the transcript cap and bounds what one
 * hit costs to analyze again.
 */
export const HIGHLIGHT_MAX_ANALYZED_CHARS = 100_000;

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
 * The _msearch header of a page search.
 *
 * A phrase ranked by relevance is scored with the term statistics of every
 * folder at once (DFS): each folder is an index of one shard, and statistics
 * taken per shard scored a match in a small folder far above the same match in
 * a big one. That costs one more round trip, so only a relevance page with a
 * phrase asks for it. Partial pages stay allowed: see warnOnPartialAnswer.
 */
function pageSearchHeader(hasQuery: boolean, sortOption: SortOption): SearchHeader {
  return hasQuery && sortOption === 'relevance' ? { search_type: 'dfs_query_then_fetch' } : {};
}

/**
 * The highlight a phrase's page asks for. Fragments wrap matches in control
 * chars the client turns into <mark>s; never HTML from the server into
 * dangerouslySetInnerHTML.
 */
const PAGE_HIGHLIGHT: estypes.SearchHighlight = {
  fields: {
    title: { number_of_fragments: 0 },
    description: { fragment_size: 160, number_of_fragments: 1 },
    commentsText: { fragment_size: 160, number_of_fragments: 1 },
    transcriptText: { fragment_size: 160, number_of_fragments: 1 },
  },
  max_analyzed_offset: HIGHLIGHT_MAX_ANALYZED_CHARS,
  pre_tags: [HIGHLIGHT_OPEN],
  post_tags: [HIGHLIGHT_CLOSE],
};

/**
 * The body of one page search: the clause to match, the channel filter as a
 * filter clause so it leaves the score alone, the sort, paging kept inside the
 * result window, and the highlight when a phrase asked for it. commentsText
 * and the other search-only or unused fields stay out of the payload, which
 * they would dominate otherwise.
 */
function pageSearchBody(
  match: Record<string, unknown>,
  sortOption: SortOption,
  options: SearchOptions,
  highlight: boolean,
): estypes.SearchSearchRequestBody {
  const { from, size } = normalizePaging(options);
  return {
    query: options.channel
      ? { bool: { must: [match], filter: [{ term: { 'channelName.keyword': options.channel } }] } }
      : match,
    sort: buildSortOptions(sortOption),
    from,
    size,
    track_total_hits: true,
    _source: {
      excludes: [...SEARCH_ONLY_SOURCE_FIELDS, ...SEARCH_EXCLUDED_SOURCE_FIELDS],
    },
    ...(highlight ? { highlight: PAGE_HIGHLIGHT } : {}),
  };
}

/** One page over the given aliases: its videos, highlights included, and the total of the same query */
async function searchPage(
  index: string[],
  body: estypes.SearchSearchRequestBody,
  header: SearchHeader,
  signal: AbortSignal | undefined,
): Promise<{ videos: VideoListItem[]; total: number }> {
  const response = await searchAliases<VideoDocument>(index, body, header, signal);
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

/**
 * The clause a typed phrase matches through: its words as typed, and within
 * the typo budget.
 *
 * The fuzzy clause alone defeated DFS. On each shard it becomes the near words
 * that shard holds, and a folder with no near word in a field gets no clause
 * for that field at all, so the DFS round read that field's statistics only
 * from the folders that matched. A title match in a one-video folder then
 * weighed what it weighs without DFS and lost to a comment match in a big
 * folder. The clause as typed looks every field up on every shard, which hands
 * DFS the statistics of the whole library, and the fuzzy clause scores on the
 * same field statistics. A word typed right scores in both clauses, so it
 * outscores a near spelling in the same field.
 */
function phraseClause(phrase: string): Record<string, unknown> {
  const asTyped = { query: phrase, fields: SEARCH_FIELDS, type: 'best_fields' };
  return { bool: { should: [{ multi_match: asTyped }, { multi_match: { ...asTyped, fuzziness: 'AUTO' } }] } };
}

/**
 * The video a search phrase names, or null for a phrase the text search
 * handles. A YouTube link names the video it points at. A bare word with the
 * shape of a video id may name one, which only the lookup can tell, since
 * "programming" has eleven characters too.
 */
function pastedVideo(phrase: string): { videoId: string; fromLink: boolean } | null {
  const linked = extractYoutubeVideoId(phrase);
  if (linked !== null) {
    return { videoId: linked, fromLink: true };
  }
  return isYoutubeVideoId(phrase) ? { videoId: phrase, fromLink: false } : null;
}

/**
 * Search videos with query, sorting and paging. `folderPaths` narrows the
 * search to those folders' indices (used by the category filter); an empty
 * array means "no folder qualifies" and yields no results. Without a sort, a
 * phrase ranks by relevance and an empty query lists the newest first.
 *
 * A pasted YouTube link or bare video id is looked up by document id first,
 * the way the details page finds a video, with the same filter, sort and
 * paging. The text search found the newest videos whose descriptions held any
 * link, and never the id itself, which no searched field carries. A link
 * answers with its video or with nothing; a bare word that names no archived
 * video goes on to the text search.
 */
export async function searchVideosWithTotal(
  query?: string,
  sortOption: SortOption = defaultSortFor(query),
  folderPaths?: string[],
  options: SearchOptions = {},
): Promise<{ videos: VideoListItem[]; total: number }> {
  if (folderPaths?.length === 0) {
    return { videos: [], total: 0 };
  }
  assertElasticsearchReachable();
  const index = getIndexPattern(folderPaths);
  const phrase = query?.trim() ?? '';

  const pasted = pastedVideo(phrase);
  if (pasted !== null) {
    const byId = pageSearchBody({ ids: { values: [pasted.videoId] } }, sortOption, options, false);
    const page = await searchPage(index, byId, pageSearchHeader(false, sortOption), options.signal);
    if (pasted.fromLink || page.total > 0) {
      return page;
    }
  }

  const match = phrase.length > 0 ? phraseClause(phrase) : { match_all: {} };
  const body = pageSearchBody(match, sortOption, options, phrase.length > 0);
  return searchPage(index, body, pageSearchHeader(phrase.length > 0, sortOption), options.signal);
}

/** Videos-only variant of the search (total dropped) */
export async function searchVideos(
  query?: string,
  sortOption: SortOption = defaultSortFor(query),
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
 * How many channel names one folder may contribute. A folder whose channel was
 * renamed keeps the old name on its older videos, and both names point at the
 * same category; ten leaves room for a few renames without unbounded buckets.
 */
const CHANNEL_NAMES_PER_FOLDER = 10;

/**
 * Where each folder's channels live: folder path to the channel names its
 * documents carry, most frequent first.
 *
 * The route turns this into the search filter's list and the console's
 * per-folder search link, so both read the same names the search filters by.
 */
export type ChannelsByFolder = Record<string, string[]>;

/** Terms bucket shape of the folder aggregation below */
interface TermsBucket {
  key: string;
  channel?: { buckets?: Array<{ key: string }> };
}

/**
 * The channel names behind every configured folder, in one query: a terms
 * bucket per folder with its channel names as a sub-aggregation.
 *
 * The folder field is `folderPath`, which the index maps as a keyword. Asking
 * for `folderPath.keyword` reads a field that does not exist, and a cluster
 * answers that with zero buckets instead of an error, which is how this map
 * stayed empty in production.
 *
 * Like searchVideos, it skips aliases that do not exist yet: a freshly
 * attached drive adds folders nobody has indexed, and the filter must keep
 * working for the indexed ones instead of failing the whole request.
 */
export async function listChannelsByFolder(): Promise<ChannelsByFolder> {
  assertElasticsearchReachable();
  const response = await searchAliases<VideoDocument>(getIndexPattern(), {
    size: 0,
    aggs: {
      folders: {
        terms: { field: 'folderPath', size: 500 },
        aggs: { channel: { terms: { field: 'channelName.keyword', size: CHANNEL_NAMES_PER_FOLDER } } },
      },
    },
  });
  const aggregations = response.aggregations as { folders?: { buckets?: TermsBucket[] } } | undefined;

  // A folder whose videos carry no channel name is left out: the console then
  // hides its search link instead of pointing at a filter that matches nothing
  const folders: ChannelsByFolder = {};
  for (const bucket of aggregations?.folders?.buckets ?? []) {
    const names = (bucket.channel?.buckets ?? []).map((channel) => channel.key);
    if (names.length > 0) {
      folders[bucket.key] = names;
    }
  }

  return folders;
}

export async function getAllVideos(sortOption: SortOption = 'date-desc'): Promise<VideoListItem[]> {
  return searchVideos(undefined, sortOption);
}

/** A single-video lookup that found nothing it may hand on, logged once */
function ignoredHit(id: string | undefined, reason: string): null {
  logger.warn(`Ignoring the index document ${JSON.stringify(id)}: ${reason}`);
  return null;
}

/**
 * The video a lookup hit names, when the server may act on it. Details,
 * comments, the summary and the file route read and write at the folder,
 * the stem and the subtitle a hit names, and Elasticsearch takes writes from
 * anyone who reaches it. So the hit must parse as a video, sit in a configured
 * folder (handed on as the configured entry), keep its stem one path
 * segment and name a subtitle of its own stem. The parse comes first: an
 * array stem would pass isSafeVideoStem.
 */
function trustedVideo(hit: estypes.SearchHit<VideoDocument> | undefined): VideoListItem | null {
  if (hit?._source === undefined) {
    return null;
  }
  const parsed = VideoListItemSchema.safeParse(hit._source);
  if (!parsed.success) {
    return ignoredHit(
      hit._id,
      `not a video (${parsed.error.issues.map((issue) => issue.path.map(String).join('.')).join(', ')})`,
    );
  }
  const video = parsed.data;
  const folderPath = findConfiguredFolder(video.folderPath);
  if (folderPath === undefined) {
    return ignoredHit(hit._id, `folder ${JSON.stringify(video.folderPath)} is not a configured one`);
  }
  if (!isSafeVideoStem(video.baseName)) {
    return ignoredHit(hit._id, `stem ${JSON.stringify(video.baseName)} is not one path segment`);
  }
  if (video.subtitlePath !== undefined && !isOwnSubtitleName(video.baseName, video.subtitlePath)) {
    return ignoredHit(hit._id, `subtitle ${JSON.stringify(video.subtitlePath)} is not one of its stem`);
  }
  return { ...fromDocument(video), folderPath };
}

async function findOne(query: Record<string, unknown>): Promise<VideoListItem | null> {
  assertElasticsearchReachable();
  const response = await searchAliases<VideoDocument>(getIndexPattern(), {
    query,
    size: 1,
    _source: {
      excludes: [...SEARCH_ONLY_SOURCE_FIELDS],
    },
  });
  return trustedVideo(response.hits.hits[0]);
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
