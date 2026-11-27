import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * In-memory fake of the Elasticsearch REST surface the videodeck server uses
 * (indices + aliases + bulk + search + delete-by-query). Deep integration
 * tests point `ELASTICSEARCH_URL` at it, so the REAL elasticsearchService
 * runs end-to-end over HTTP without Docker.
 *
 * Fidelity: the wire contract plus the cluster semantics the service leans on.
 * Each of these has a test over the fake's own HTTP surface in
 * `server/src/test/fakeElasticsearch.test.ts`:
 *
 * - the search analyzer's asciifolding, `ł` included. Unicode NFD alone leaves
 *   that letter alone, so a fake that stops there answers empty for a query
 *   the real cluster matches ("folds diacritics the way the real analyzer
 *   does, including ł").
 * - `index.max_result_window`: a page whose `from + size` passes 10000 gets
 *   the real 400 body, while a page that ends exactly at the window still
 *   serves ("refuses a page past the result window the way Elasticsearch
 *   does", "still serves a page that ends exactly at the result window").
 * - the bulk `errors` flag, false only when every item landed ("reports
 *   errors: false when every bulk item succeeded", "reports errors: true when
 *   any bulk item failed"). The failing item in that scenario breaks the
 *   mapping: its count falls outside the range its field type accepts, int32
 *   for `integer` and int64 for `long`, which a real cluster answers with a
 *   per-item document_parsing_exception ("stores a count past int32 in a long
 *   field and refuses it in an integer one"). Single-document writes are not
 *   range-checked.
 * - a numeric sort compares numbers by value, across an integer and a long
 *   index alike ("sorts counts by value across an integer and a long index").
 *   The `numeric_type` the service's sort names is accepted and ignored: the
 *   fake has no per-index sort types for it to reconcile.
 * - a mapping read through an alias answers with the mapping the index was
 *   created with, `_meta` included, where the boot check finds the analysis
 *   version ("hands back the _meta an index was created with on a mapping
 *   read"). Analysis settings are kept but never applied.
 * - a bulk item aimed at an index that does not exist answers 404 instead of
 *   auto-creating the index ("refuses a bulk item whose index does not
 *   exist"). The service always creates its index before writing, so the
 *   strict answer catches a typo; a default cluster auto-creates instead.
 * - a terms aggregation buckets only the fields the stored mapping declares,
 *   subfields included, and answers an unmapped one with no buckets at all
 *   ("buckets a terms aggregation only on a field the index mapping
 *   declares"). That is what a cluster does with the `folderPath.keyword` the
 *   service used to ask for, which is why the mistake stayed quiet.
 * - a term query resolves its field through the same mapping. A keyword field
 *   or keyword subfield compares the raw value, and a name the mapping does
 *   not declare matches nothing ("matches nothing for a term on a subfield the
 *   mapping does not declare"). Full-text matching stays lenient: multi_match
 *   still folds a subfield away.
 * - a bool query needs every must and filter clause and minimum_should_match
 *   of its should clauses, which defaults to one for a should list on its own
 *   and to none next to must or filter. getVideoByFilePath sends that should
 *   list, and a fake that dropped it resolved every file name to the first
 *   video ("finds a video by its video or thumbnail file name, and nothing for
 *   a name no video holds").
 * - a query shape outside that set answers 500 with a message naming it,
 *   instead of matching every document: a leaf clause other than match_all,
 *   multi_match, term, range and ids, a bool key such as must_not, or a term
 *   on a field that is not a keyword ("answers a query shape it does not model
 *   with a 500 that names it"). An index with no documents never runs its
 *   query, so there the refusal waits for the first document.
 * - `http.max_initial_line_length`: a request whose first line passes 4096
 *   bytes gets the cluster's 400 before any index is read ("refuses a request
 *   line past 4 KB the way Elasticsearch does"). An alias list in a _search
 *   URL crosses it at 156 folders, which is why the service searches through
 *   _msearch.
 * - `_msearch` answers each header and body pair with its own response and
 *   `status`, and a refused search fails its own item inside a 200 ("answers
 *   _msearch with one response per search"). A header other than the one the
 *   service sends, an index list with ignore_unavailable true and optionally
 *   allow_partial_search_results and search_type, answers 500 ("takes the
 *   _msearch header the service sends and refuses any other with a 500 that
 *   names it"). search_type is accepted and ignored: the fake's score counts
 *   matches with no IDF, so dfs_query_then_fetch has nothing to change, and
 *   only the real-ES suite shows what it does to a ranking.
 * - `index.highlight.max_analyzed_offset`, one shard per index as in the
 *   service's indices, and `_shards` in every answer. A page hit whose
 *   highlighted field passes 1,000,000 characters fails its index's shard in
 *   the fetch phase, unless the request's own max_analyzed_offset sits at or
 *   below that limit and truncates the field. The failed shard's hits leave
 *   the page and stay in the total; with every shard failed, or partial
 *   results refused, the search answers 400 ("fails the shard of a hit whose
 *   highlighted field passes the analyzed-offset limit, unless the request
 *   caps it", "refuses a page with a failed shard when partial results are
 *   not allowed").
 * - a write block, the one index.blocks.read_only_allow_delete puts on an
 *   index and the flood-stage disk watermark sets on every index of a full
 *   node (blockWrites). Bulk items into the index and single-document writes
 *   answer 429 cluster_block_exception while reads go on, and the blocks
 *   section of the cluster state lists it under the physical index until the
 *   index is deleted ("lists a write block the way Elasticsearch does, and
 *   refuses writes into the index it blocks", "drops the write block of an
 *   index it deletes, as the cluster does"). That section, asked for with no
 *   parameter, is the only cluster state the fake serves; any other cluster
 *   request answers 500 ("answers a cluster state request it does not model
 *   with a 500 that names it").
 *
 * Search, over a _search URL or an _msearch pair, still implements only the
 * query shapes the service sends (match_all, multi_match over SEARCH_FIELDS,
 * bool must/filter/should, term on keyword fields, ids,
 * uploadDate/viewCount/likeCount sorts, highlight fragments with the service's
 * control chars). Everything else the real-ES CI integration suite covers
 * against an actual cluster.
 */

interface DocumentEntry {
  id: string;
  source: Record<string, unknown>;
  /** The mapping of the index the document lives in, for field resolution */
  mapping: Record<string, unknown>;
}

interface IndexEntry {
  /** The physical index name, which a shard failure reports */
  name: string;
  documents: Map<string, DocumentEntry>;
  /** The last mapping body PUT with the index (settings/mappings kept verbatim) */
  mappings: Record<string, unknown>;
}

interface SearchBody {
  query?: Record<string, unknown>;
  sort?: unknown;
  from?: number;
  size?: number;
  highlight?: {
    fields?: Record<string, unknown>;
    pre_tags?: string[];
    post_tags?: string[];
    max_analyzed_offset?: number;
  };
  _source?: { excludes?: string[] } | boolean;
}

/**
 * Letters Lucene's ASCIIFoldingFilter folds to ASCII while Unicode NFD leaves
 * them alone. The real index analyzer is `standard` + lowercase +
 * asciifolding + the English possessive stemmer, so `ł` has to search as `l`;
 * Polish needs that one, and the rest of the table covers the usual European
 * letters. The fake does not run the possessive stemmer: splitting terms on
 * the apostrophe stands in for it, so only the real-cluster suite can tell a
 * possessive regression ("matches an English possessive through its base
 * word").
 */
const ASCII_FOLD_SPECIALS: Record<string, string> = {
  ß: 'ss',
  æ: 'ae',
  œ: 'oe',
  þ: 'th',
  ð: 'd',
  ø: 'o',
  ł: 'l',
  đ: 'd',
  ħ: 'h',
  ı: 'i',
  ŋ: 'n',
  ŧ: 't',
  ĸ: 'k',
  ſ: 's',
};

/**
 * The cluster's default `index.max_result_window`. Deliberately hardcoded:
 * the fake has to refuse pages the real cluster refuses, so it must not
 * follow the constant the code under test derives its paging from.
 */
const RESULT_WINDOW = 10_000;

/**
 * The cluster's default `http.max_initial_line_length`, 4kb, which is a static
 * setting. Hardcoded for the reason RESULT_WINDOW is.
 */
const MAX_INITIAL_LINE_LENGTH = 4096;

/** The 400 body a cluster answers a request line past that length with */
function tooLongLineError(): Record<string, unknown> {
  const cause = {
    type: 'too_long_http_line_exception',
    reason: `An HTTP line is larger than ${MAX_INITIAL_LINE_LENGTH} bytes.`,
  };
  return { error: { root_cause: [cause], ...cause }, status: 400 };
}

/**
 * The block index.blocks.read_only_allow_delete puts on an index, under its id
 * as the cluster state lists it. Hardcoded like RESULT_WINDOW: the fake has to
 * answer what a cluster answers, not what the code under test expects.
 */
const WRITE_BLOCK_ID = '12';
const WRITE_BLOCK = {
  description: 'disk usage exceeded flood-stage watermark, index has read-only-allow-delete block',
  retryable: false,
  levels: ['write', 'metadata_write'],
};

/** The error a cluster answers a write into an index carrying that block with */
function writeBlockedError(index: string): { type: string; reason: string } {
  return {
    type: 'cluster_block_exception',
    reason: `index [${index}] blocked by: [TOO_MANY_REQUESTS/${WRITE_BLOCK_ID}/${WRITE_BLOCK.description}];`,
  };
}

/** One search of an _msearch body: its header line and its body line */
interface MsearchPair {
  header: Record<string, unknown>;
  body: SearchBody;
}

/**
 * The msearch header keys the fake models: the ones the service sends. Its
 * score has no IDF, so search_type, which only decides where a cluster takes
 * its term statistics from, changes nothing here and is read as a no-op.
 */
const MSEARCH_HEADER_KEYS = new Set(['index', 'ignore_unavailable', 'allow_partial_search_results', 'search_type']);

/** An _msearch NDJSON body, read into its header and body pairs */
function msearchPairs(rawBody: string): MsearchPair[] {
  const lines = rawBody.split('\n').filter((line) => line.trim().length > 0);
  if (lines.length % 2 !== 0) {
    throw new Error('an _msearch body needs a body line after every header line');
  }
  const pairs: MsearchPair[] = [];
  for (let i = 0; i < lines.length; i += 2) {
    pairs.push({
      header: JSON.parse(lines[i] ?? '{}') as Record<string, unknown>,
      body: JSON.parse(lines[i + 1] ?? '{}') as SearchBody,
    });
  }
  return pairs;
}

/**
 * The names one msearch header targets. Only the header the service sends is
 * modelled: an index name or a list of them, with ignore_unavailable true, so
 * a name nothing holds is skipped the way a cluster skips it. Without an index
 * a cluster searches every index, without ignore_unavailable it fails on a
 * missing name, and any other key may route or score the search differently,
 * so each of those is refused rather than guessed.
 */
function msearchTargets(header: Record<string, unknown>): string[] {
  const unmodelled = Object.keys(header).find((key) => !MSEARCH_HEADER_KEYS.has(key));
  if (unmodelled !== undefined) {
    throw new Error(`the msearch header key ${unmodelled} is not modelled`);
  }
  const names = typeof header.index === 'string' ? header.index.split(',') : header.index;
  if (!Array.isArray(names) || names.length === 0 || names.some((name) => typeof name !== 'string' || !name.trim())) {
    throw new Error('an msearch header without an index is not modelled');
  }
  if (header.ignore_unavailable !== true) {
    throw new Error('an msearch header without ignore_unavailable: true is not modelled');
  }
  return names as string[];
}

/** One failed shard, as a search answer reports it */
interface ShardFailure {
  index: string;
  reason: { type: string; reason: string };
}

/** The 400 body a cluster answers a search with when its shards failed */
function searchPhaseError(phase: string, reason: string, failures: ShardFailure[]): Record<string, unknown> {
  return {
    error: {
      root_cause: failures.slice(0, 1).map((failure) => failure.reason),
      type: 'search_phase_execution_exception',
      reason,
      phase,
      grouped: true,
      failed_shards: failures.map((failure) => ({ shard: 0, node: 'fake-node', ...failure })),
    },
    status: 400,
  };
}

/** The 400 body a real cluster answers a page past the window with */
function resultWindowError(target: string, requested: number): Record<string, unknown> {
  const reason =
    `Result window is too large, from + size must be less than or equal to: [${RESULT_WINDOW}] but was [${requested}]. ` +
    'See the scroll api for a more efficient way to request large data sets. This limit can be set by changing the ' +
    '[index.max_result_window] index level setting.';
  return searchPhaseError('query', 'all shards failed', [
    { index: target, reason: { type: 'illegal_argument_exception', reason } },
  ]);
}

/**
 * The cluster's default `index.highlight.max_analyzed_offset`: how many
 * characters of one field the highlighter analyzes. Hardcoded like
 * RESULT_WINDOW.
 */
const INDEX_MAX_ANALYZED_OFFSET = 1_000_000;

/** The shard failure a cluster's highlighter reports for a field past that limit */
function analyzedOffsetFailure(index: string, field: string, length: number): ShardFailure {
  const reason =
    `The length [${length}] of field [${field}] in doc[0]/index[${index}] exceeds the ` +
    `[index.highlight.max_analyzed_offset] limit [${INDEX_MAX_ANALYZED_OFFSET}]. To avoid this error, set the ` +
    `query parameter [max_analyzed_offset] to a value less than index setting [${INDEX_MAX_ANALYZED_OFFSET}] and ` +
    'this will tolerate long field values by truncating them.';
  return { index, reason: { type: 'illegal_argument_exception', reason } };
}

/**
 * How much of a field the highlighter reads for this request, or null when a
 * field past the index limit fails its shard instead. A request cap at or
 * below that limit truncates the field; a missing or larger one does not, the
 * index setting prevails and the field fails the fetch.
 */
function analyzedLength(highlight: NonNullable<SearchBody['highlight']>): number | null {
  const requested = highlight.max_analyzed_offset;
  return requested !== undefined && requested <= INDEX_MAX_ANALYZED_OFFSET ? requested : null;
}

/** The `_shards` block of a search answer, failures listed when there are any */
function shardStatistics(total: number, failures: ShardFailure[]): Record<string, unknown> {
  return {
    total,
    successful: total - failures.length,
    skipped: 0,
    failed: failures.length,
    ...(failures.length > 0
      ? { failures: failures.map((failure) => ({ shard: 0, node: 'fake-node', ...failure })) }
      : {}),
  };
}

/** One search's answer, before a route writes it out: a _search body or an _msearch item */
interface SearchAnswer {
  status: number;
  body: Record<string, unknown>;
}

/**
 * The range each mapped whole-number type accepts. A count past it is the one
 * per-item failure the service has to survive: `toDocument` normalises the
 * counts, so a hand-edited info.json reaches the cluster as a number its field
 * refuses. The bounds are BigInts, so a long compares exactly: every double
 * below 2^63 fits, and 2^63 itself, the first double past Long.MAX_VALUE, is
 * refused like the cluster refuses it.
 */
const WHOLE_NUMBER_RANGES: Record<string, { min: bigint; max: bigint } | undefined> = {
  integer: { min: -(2n ** 31n), max: 2n ** 31n - 1n },
  long: { min: -(2n ** 63n), max: 2n ** 63n - 1n },
};

/** One property of an index mapping: its type, plus the subfields it declares */
interface MappingProperty {
  type?: string;
  fields?: Record<string, { type?: string } | undefined>;
}

/** The bool keys the fake models: the ones the service sends */
interface BoolQuery {
  must?: Array<Record<string, unknown>>;
  filter?: Array<Record<string, unknown>>;
  should?: Array<Record<string, unknown>>;
  minimum_should_match?: number;
}

const BOOL_KEYS = new Set(['must', 'filter', 'should', 'minimum_should_match']);

/** The slice of a terms aggregation definition the fake reads */
interface TermsDefinition {
  terms?: { field?: string; size?: number };
  aggs?: Record<string, unknown>;
}

/** The `properties` of the mapping stored with an index, empty when it has none */
function mappingProperties(mapping: Record<string, unknown>): Record<string, MappingProperty> {
  const stored = mapping.mappings as { properties?: Record<string, MappingProperty> } | undefined;
  return stored?.properties ?? {};
}

/**
 * The value as an exact whole number, or null when it is none. A digit string
 * counts, coerced the way the cluster coerces it.
 */
function wholeNumberOf(value: unknown): bigint | null {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return BigInt(value);
  }
  return typeof value === 'string' && /^-?\d+$/.test(value) ? BigInt(value) : null;
}

/**
 * The per-item error a real cluster answers a document with when a field the
 * index maps as `integer` or `long` holds a value outside that type's range.
 * Returns undefined when every such field is in range.
 */
function numericRangeFailure(
  entry: IndexEntry,
  document: Record<string, unknown>,
): Record<string, unknown> | undefined {
  for (const [field, spec] of Object.entries(mappingProperties(entry.mappings))) {
    const type = spec?.type ?? '';
    const range = WHOLE_NUMBER_RANGES[type];
    const value = document[field];
    if (range === undefined || value === undefined || value === null) {
      continue;
    }
    const whole = wholeNumberOf(value);
    if (whole !== null && whole >= range.min && whole <= range.max) {
      continue;
    }
    return {
      type: 'document_parsing_exception',
      reason: `failed to parse field [${field}] of type [${type}]`,
      caused_by: {
        type: 'illegal_argument_exception',
        reason: `Value [${String(value)}] is out of range for ${type === 'integer' ? 'an integer' : 'a long'}`,
      },
    };
  }
  return undefined;
}

/** Strip diacritics + lowercase, mirroring the search analyzer's asciifolding */
function fold(value: string): string {
  return value
    .toLowerCase()
    .replace(/[ßæœþðøłđħıŋŧĸſ]/g, (char) => ASCII_FOLD_SPECIALS[char] ?? char)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function termsOf(query: string): string[] {
  return fold(query)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length > 0);
}

/**
 * Lucene's AUTO fuzziness: no edits for one or two characters, one up to five,
 * two beyond that. The production query asks for AUTO, so the fake has to know
 * the same budget or a typo the cluster tolerates comes back empty here.
 */
function autoFuzzinessBudget(term: string): number {
  if (term.length <= 2) {
    return 0;
  }
  return term.length <= 5 ? 1 : 2;
}

/** The edit budget one query term gets from the request's `fuzziness` */
function fuzzinessBudget(term: string, fuzziness: unknown): number {
  if (typeof fuzziness === 'number') {
    return fuzziness;
  }
  if (typeof fuzziness === 'string' && fuzziness.toUpperCase() === 'AUTO') {
    return autoFuzzinessBudget(term);
  }
  return 0;
}

/**
 * Whether two tokens are within `max` edits of each other:
 * Damerau-Levenshtein with adjacent transpositions, like Lucene's fuzzy query,
 * and bounded, so a fuzzy search over a deep suite stays cheap.
 */
/** The state one Damerau-Levenshtein row needs from the row above it */
interface EditRow {
  left: string;
  right: string;
  row: number;
  previous: number[];
  twoRowsBack: number[] | null;
}

/** One Damerau-Levenshtein row, including adjacent transpositions */
function nextEditRow({ left, right, row, previous, twoRowsBack }: EditRow): number[] {
  const current = new Array<number>(right.length + 1).fill(0);
  current[0] = row;
  for (let column = 1; column <= right.length; column += 1) {
    const substitution = (previous[column - 1] ?? 0) + (left[row - 1] === right[column - 1] ? 0 : 1);
    const transposed =
      row > 1 && column > 1 && left[row - 1] === right[column - 2] && left[row - 2] === right[column - 1]
        ? (twoRowsBack?.[column - 2] ?? Number.MAX_SAFE_INTEGER) + 1
        : Number.MAX_SAFE_INTEGER;
    current[column] = Math.min((previous[column] ?? 0) + 1, (current[column - 1] ?? 0) + 1, substitution, transposed);
  }
  return current;
}

/**
 * Whether two tokens are within `max` edits of each other:
 * Damerau-Levenshtein with adjacent transpositions, like Lucene's fuzzy query,
 * and bounded, so a fuzzy search over a deep suite stays cheap.
 */
function withinEditDistance(left: string, right: string, max: number): boolean {
  if (left === right) {
    return true;
  }
  if (max <= 0 || Math.abs(left.length - right.length) > max) {
    return false;
  }
  let twoRowsBack: number[] | null = null;
  let previous = Array.from({ length: right.length + 1 }, (_unused, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = nextEditRow({ left, right, row, previous, twoRowsBack });
    if (Math.min(...current) > max) {
      return false;
    }
    twoRowsBack = previous;
    previous = current;
  }
  return (previous[right.length] ?? 0) <= max;
}

/** Whether an analysed field holds one query term, exactly or within budget */
function holdsTerm(text: string, term: string, budget: number): boolean {
  return termsOf(text).some((token) => withinEditDistance(token, term, budget));
}

function readJsonBody(req: IncomingMessage, rawBody: string, pathname: string): unknown {
  if (req.headers['content-type']?.includes('ndjson')) {
    return pathname === '/_msearch' ? msearchPairs(rawBody) : rawBody;
  }
  if (!rawBody) {
    return {};
  }
  try {
    return JSON.parse(rawBody);
  } catch {
    throw new Error('fake-elasticsearch: malformed JSON body');
  }
}

function notFound(name: string): { error: Record<string, unknown>; status: number } {
  return { error: { type: 'index_not_found_exception', resource: { id: name } }, status: 404 };
}

/** '/videos_a/_search' → ['videos_a', '_search']; '/videos_a' → ['videos_a', undefined] */
function splitPath(pathname: string): [string, string | undefined] {
  const parts = pathname.slice(1).split('/');
  if (parts.length === 1 && parts[0] === '') {
    return ['', undefined];
  }
  return [parts[0] ?? '', parts.length > 1 ? parts[parts.length - 1] : undefined];
}

export interface FakeEsRequest {
  method: string;
  /** pathname plus query string, as received */
  path: string;
  /** Parsed JSON body when the request carried one; an _msearch body as its header and body pairs */
  body?: unknown;
}

/** What holdRequestsMatching hands back */
export interface HeldRequests {
  /** Settles when the first matching request arrives */
  reached: Promise<void>;
  /** Settles when a held request's connection closes before the fake answered it */
  abandoned: Promise<void>;
  /** Answer the held requests, and stop holding new ones */
  release: () => void;
}

/** One search the fake ran, whether a _search URL or an _msearch pair asked for it */
export interface FakeEsSearch {
  /** The index or alias names the search targeted, in request order */
  index: string[];
  /** The search body as received: query, sort, paging, highlight, aggregations */
  body: Record<string, unknown>;
}

export class FakeElasticsearch {
  private readonly indices = new Map<string, IndexEntry>();
  private readonly aliases = new Map<string, string>();
  private readonly requests: FakeEsRequest[] = [];
  private readonly searches: FakeEsSearch[] = [];
  private readonly faults: Array<{ match: string | RegExp; status: number }> = [];
  private readonly holds: Array<{
    match: string | RegExp;
    arrive: () => void;
    abandon: () => void;
    released: Promise<void>;
  }> = [];
  private readonly releases = new Set<() => void>();
  /** Physical indices whose writes blockWrites refuses */
  private readonly writeBlocked = new Set<string>();
  private server: Server | null = null;
  private port: number | null = null;

  /** Every request the app sent, in order */
  get requestLog(): FakeEsRequest[] {
    return [...this.requests];
  }

  /** Every search the fake ran, in order, a refused page included (assertions on search bodies) */
  get searchLog(): FakeEsSearch[] {
    return [...this.searches];
  }

  /** Answer requests whose path contains the substring with this status */
  failRequestsMatching(match: string | RegExp, status: number): void {
    this.faults.push({ match, status });
  }

  clearFailures(): void {
    this.faults.length = 0;
  }

  /**
   * Hold the requests whose path matches until `release` runs, so a test can
   * act while one step of a longer flow waits (a reindex's bulk write).
   * `reached` settles when the first such request arrives, and `abandoned`
   * when a held request's connection closes before the fake answered it, the
   * way a cluster sees a client that gave up. `stop` releases every hold, so a
   * failed assertion cannot leave a request hanging.
   */
  holdRequestsMatching(match: string | RegExp): HeldRequests {
    let arrive: () => void = () => undefined;
    let abandon: () => void = () => undefined;
    let open: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => {
      arrive = resolve;
    });
    const abandoned = new Promise<void>((resolve) => {
      abandon = resolve;
    });
    const released = new Promise<void>((resolve) => {
      open = resolve;
    });
    const hold = { match, arrive, abandon, released };
    this.holds.push(hold);
    const release = (): void => {
      this.releases.delete(release);
      const index = this.holds.indexOf(hold);
      if (index !== -1) {
        this.holds.splice(index, 1);
      }
      open();
    };
    this.releases.add(release);
    return { reached, abandoned, release };
  }

  /**
   * Refuse the writes into an index from now on, the way
   * index.blocks.read_only_allow_delete does: bulk items into it and
   * single-document writes answer 429, reads go on, and the cluster state
   * lists the block. An alias blocks the index it points at, where a cluster
   * keeps the setting. A name the fake does not hold throws.
   */
  blockWrites(name: string): void {
    this.writeBlocked.add(this.physicalName(name));
  }

  /** Take the writes again, as clearing the setting does */
  unblockWrites(name: string): void {
    this.writeBlocked.delete(this.physicalName(name));
  }

  /** The physical index an index or alias name resolves to, for a test control */
  private physicalName(name: string): string {
    const entry = this.resolve(name);
    if (!entry) {
      throw new Error(`fake-elasticsearch: ${name} is neither an index nor an alias`);
    }
    return entry.name;
  }

  /** The physical index an alias currently points at, if any */
  aliasOf(name: string): string | undefined {
    return this.aliases.get(name);
  }

  /** Every physical index name, in creation order */
  indexNames(): string[] {
    return [...this.indices.keys()];
  }

  /** The physical index an index-or-alias name resolves to */
  private resolve(name: string): IndexEntry | undefined {
    return this.indices.get(this.aliases.get(name) ?? name);
  }

  /** The physical indices behind index, alias and wildcard names, in that order */
  private resolveTargets(names: readonly string[]): IndexEntry[] {
    const entries: IndexEntry[] = [];
    for (const name of names.map((part) => part.trim()).filter(Boolean)) {
      if (name.includes('*')) {
        const pattern = new RegExp(`^${name.replace(/\*/g, '.*')}$`);
        for (const [indexName, entry] of this.indices) {
          if (pattern.test(indexName)) {
            entries.push(entry);
          }
        }
      } else {
        const entry = this.resolve(name);
        if (entry) {
          entries.push(entry);
        }
      }
    }
    return entries;
  }

  /**
   * Start listening; resolves with the base URL. Without a port it takes an
   * ephemeral one, and a later restart rebinds the same port so the app's
   * already-configured ELASTICSEARCH_URL keeps pointing here.
   */
  async start(port = 0): Promise<string> {
    const server = createServer((req, res) => this.handle(req, res));
    this.server = server;
    await new Promise<void>((resolve) => {
      server.listen(port, '127.0.0.1', resolve);
    });
    const bound = (server.address() as AddressInfo).port;
    this.port = bound;
    return `http://127.0.0.1:${bound}`;
  }

  /** Stop listening: the next client call fails like a stopped container. */
  async stop(): Promise<void> {
    for (const release of [...this.releases]) {
      release();
    }
    const server = this.server;
    this.server = null;
    if (!server) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  /**
   * Give Elasticsearch back on the port it had, for a test that takes it away
   * and then checks that the app recovers.
   */
  async restart(): Promise<string> {
    const port = this.port;
    if (port === null) {
      throw new Error('fake-elasticsearch: restart needs a previous start()');
    }
    await this.stop();
    return this.start(port);
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    // The official client's ProductCheck middleware refuses servers that do
    // not identify as Elasticsearch.
    res.writeHead(status, { 'content-type': 'application/json', 'x-elastic-product': 'Elasticsearch' });
    res.end(JSON.stringify(body));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://fake');
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    const rawBody = Buffer.concat(chunks).toString('utf-8');

    try {
      const body = readJsonBody(req, rawBody, url.pathname);
      const [path, suffix] = splitPath(url.pathname);
      const name = suffix !== undefined ? decodeURIComponent(path) : decodeURIComponent(url.pathname.slice(1));

      this.requests.push({
        method: req.method ?? 'GET',
        path: url.pathname + url.search,
        ...(body === undefined ? {} : { body }),
      });

      // Netty refuses the line before Elasticsearch routes anything, so no
      // hold or fault applies to it either
      if (Buffer.byteLength(`${req.method} ${req.url} HTTP/${req.httpVersion}`) > MAX_INITIAL_LINE_LENGTH) {
        this.json(res, 400, tooLongLineError());
        return;
      }

      const target = url.pathname + url.search;
      const hold = this.holds.find((entry) =>
        typeof entry.match === 'string' ? target.includes(entry.match) : entry.match.test(target),
      );
      if (hold) {
        // The response's close, not the request's: the request closes once its
        // body is read, the response when the client drops the connection
        res.once('close', () => {
          if (!res.writableFinished) {
            hold.abandon();
          }
        });
        hold.arrive();
        await hold.released;
      }
      const fault = this.faults.find((entry) =>
        typeof entry.match === 'string' ? target.includes(entry.match) : entry.match.test(target),
      );
      if (fault) {
        this.json(res, fault.status, { error: { type: 'fake-fault', status: fault.status } });
        return;
      }

      if (!this.handleWellKnownRoutes(req, res, url, name, suffix, body)) {
        this.handleNamedRoutes(req, res, name, body, url.searchParams);
      }
    } catch (error) {
      const message = `fake-elasticsearch: ${error instanceof Error ? error.message : String(error)} at ${req.method} ${url.pathname}`;
      this.json(res, 500, { error: message });
    }
  }

  /** Path-level endpoints (no index name). Returns true when handled. */
  private handleWellKnownRoutes(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    name: string,
    suffix: string | undefined,
    body: unknown,
  ): boolean {
    if (req.method === 'HEAD' && url.pathname === '/') {
      res.writeHead(200, { 'x-elastic-product': 'Elasticsearch' });
      res.end();
      return true;
    }
    if (url.pathname.startsWith('/_cluster/')) {
      this.handleClusterRoutes(res, url);
      return true;
    }
    if (url.pathname === '/_aliases') {
      if (req.method === 'POST') {
        this.applyAliases(body);
        this.json(res, 200, { acknowledged: true });
      } else {
        this.json(res, 200, this.aliasSnapshot());
      }
      return true;
    }
    if (this.handleDataRoutes(req, res, url, suffix, body)) {
      return true;
    }
    if (url.pathname === '/_msearch') {
      this.msearch(res, body as MsearchPair[]);
      return true;
    }
    if (suffix === '_search') {
      this.search(res, name, body as SearchBody, url.searchParams);
      return true;
    }
    if (suffix === '_count') {
      this.count(res, name);
      return true;
    }
    if (suffix === '_delete_by_query') {
      this.deleteByQuery(res, name, body);
      return true;
    }
    if (suffix === '_refresh') {
      this.json(res, 200, { _shards: { successful: 1, failed: 0 } });
      return true;
    }
    if (suffix === '_mapping' || suffix === '_settings') {
      this.handleMapping(res, name);
      return true;
    }
    return false;
  }

  /**
   * The cluster-level reads: health, which the fake's own tests hold, and the
   * blocks section of the cluster state, which the health probe asks for.
   * Anything else answers 500, a cluster state metric other than blocks or a
   * parameter on it included: another metric carries sections the fake does
   * not keep, and a parameter such as local changes which node answers.
   */
  private handleClusterRoutes(res: ServerResponse, url: URL): void {
    if (url.pathname === '/_cluster/health') {
      this.json(res, 200, { status: 'green' });
      return;
    }
    const request = url.pathname + url.search;
    if (request !== '/_cluster/state/blocks') {
      throw new Error(`the cluster request ${request} is not modelled`);
    }
    const indices = [...this.writeBlocked].map((index) => [index, { [WRITE_BLOCK_ID]: WRITE_BLOCK }]);
    this.json(res, 200, {
      cluster_name: 'fake-elasticsearch',
      cluster_uuid: 'fake-elasticsearch',
      // No block at the cluster level, and the section is empty without any
      blocks: indices.length === 0 ? {} : { indices: Object.fromEntries(indices) },
    });
  }

  /** Bulk, alias and single-document routes. True when one handled the request. */
  private handleDataRoutes(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    suffix: string | undefined,
    body: unknown,
  ): boolean {
    if (this.handleAliasRoutes(req, res, url)) {
      return true;
    }
    if (url.pathname === '/_bulk' || suffix === '_bulk') {
      this.bulk(res, body);
      return true;
    }
    return this.handleDocRoutes(res, url, body);
  }

  /**
   * HEAD/GET /_alias/<name> — the official client probes existsAlias and
   * reads getAlias here. Without it every existsAlias answers "missing",
   * so createIndex would rebuild and re-promote the folder index on every
   * incremental write, wiping the documents it just stored. Returns true
   * when the path is an alias probe.
   */
  private handleAliasRoutes(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
    if (!url.pathname.startsWith('/_alias/')) {
      return false;
    }
    const alias = decodeURIComponent(url.pathname.slice('/_alias/'.length));
    const index = this.aliases.get(alias);
    if (index === undefined) {
      this.json(res, 404, notFound(alias));
    } else if (req.method === 'HEAD') {
      res.writeHead(200, { 'x-elastic-product': 'Elasticsearch' });
      res.end();
    } else {
      this.json(res, 200, { [index]: { aliases: { [alias]: {} } } });
    }
    return true;
  }

  /**
   * PUT /:index/_doc/:id — the single-document index API the post-job
   * incremental indexing uses (indexVideo). The document goes into the
   * physical index behind the alias, exactly like bulk does. Returns true
   * when the path is a document index write.
   */
  private handleDocRoutes(res: ServerResponse, url: URL, body: unknown): boolean {
    if (url.pathname.split('/')[2] !== '_doc') {
      return false;
    }
    this.indexDocument(res, url.pathname, body);
    return true;
  }

  /** GET /:index/_mapping and /:index/_settings (legacy-mapping checks) */
  private handleMapping(res: ServerResponse, name: string): void {
    const entry = this.resolve(name);
    if (!entry) {
      this.json(res, 404, notFound(name));
    } else {
      this.json(res, 200, { [this.aliases.get(name) ?? name]: entry.mappings });
    }
  }

  /** Index/alias-name endpoints (exists, get, create, delete) */
  private handleNamedRoutes(
    req: IncomingMessage,
    res: ServerResponse,
    name: string,
    body: unknown,
    searchParams: URLSearchParams,
  ): void {
    switch (req.method) {
      case 'HEAD': {
        const exists = this.indices.has(name) || this.aliases.has(name);
        res.writeHead(exists ? 200 : 404, { 'x-elastic-product': 'Elasticsearch' });
        res.end();
        return;
      }
      case 'GET': {
        this.handleGet(res, name);
        return;
      }
      case 'PUT': {
        this.createNamedIndex(res, name, body);
        return;
      }
      case 'DELETE': {
        this.deleteNamedIndex(res, name, searchParams);
        return;
      }
      default:
        this.json(res, 405, { error: `fake-elasticsearch: unsupported ${req.method}` });
    }
  }

  /** PUT /:index — refuses to replace an index the cluster already holds */
  private createNamedIndex(res: ServerResponse, name: string, body: unknown): void {
    if (this.indices.has(name)) {
      this.json(res, 400, {
        error: { type: 'resource_already_exists_exception', index: name },
        status: 400,
      });
      return;
    }
    const mappings = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    this.indices.set(name, { name, documents: new Map(), mappings });
    this.json(res, 200, { acknowledged: true, index: name });
  }

  /**
   * DELETE /:index — 404 for a name nothing holds, unless the caller passed
   * `ignore_unavailable`, which is the flag the production deletes use for a
   * path that may already be gone.
   */
  private deleteNamedIndex(res: ServerResponse, name: string, searchParams: URLSearchParams): void {
    if (!this.indices.has(name)) {
      const ignored = searchParams.get('ignore_unavailable');
      if (ignored === 'true' || ignored === '') {
        this.json(res, 200, { acknowledged: true });
        return;
      }
      this.json(res, 404, notFound(name));
      return;
    }
    this.indices.delete(name);
    // The block lives in the index settings, so it goes with the index
    this.writeBlocked.delete(name);
    for (const [alias, index] of this.aliases) {
      if (index === name) {
        this.aliases.delete(alias);
      }
    }
    this.json(res, 200, { acknowledged: true });
  }

  private handleGet(res: ServerResponse, name: string): void {
    // Pattern reads (allow_no_indices): list matching physical indices
    if (name.includes('*')) {
      const pattern = new RegExp(`^${name.replace(/\*/g, '.*')}$`);
      const matches: Record<string, unknown> = {};
      for (const indexName of this.indices.keys()) {
        if (pattern.test(indexName)) {
          matches[indexName] = { aliases: {} };
        }
      }
      this.json(res, 200, matches);
      return;
    }
    // indices.getAlias({ name }) — only physical indices answer
    if (this.indices.has(name)) {
      const aliases = Object.fromEntries(
        [...this.aliases].filter(([, index]) => index === name).map(([alias]) => [alias, {}]),
      );
      this.json(res, 200, { [name]: { aliases } });
      return;
    }
    if (this.aliases.has(name)) {
      const index = this.aliases.get(name);
      this.json(res, 200, { [index ?? name]: { aliases: { [name]: {} } } });
      return;
    }
    this.json(res, 404, notFound(name));
  }

  private applyAliases(body: unknown): void {
    const actions = (body as { actions?: unknown[] }).actions ?? [];
    for (const action of actions) {
      const add = (action as { add?: { index: string; alias: string } }).add;
      const remove = (action as { remove?: { index: string; alias: string } }).remove;
      if (add) {
        this.aliases.set(add.alias, add.index);
      } else if (remove) {
        this.aliases.delete(remove.alias);
      }
    }
  }

  private aliasSnapshot(): Record<string, unknown> {
    const snapshot: Record<string, unknown> = {};
    for (const [indexName] of this.indices) {
      snapshot[indexName] = { aliases: {} };
    }
    for (const [alias, index] of this.aliases) {
      const existing = snapshot[index];
      const entry = (existing ?? { aliases: {} }) as { aliases: Record<string, unknown> };
      entry.aliases[alias] = {};
      snapshot[index] = entry;
    }
    return snapshot;
  }

  private bulk(res: ServerResponse, body: unknown): void {
    const lines = String(body)
      .split('\n')
      .filter((line) => line.trim().length > 0);
    const items: unknown[] = [];
    let errors = false;
    for (let i = 0; i + 1 < lines.length; i += 2) {
      const op = JSON.parse(lines[i] ?? '') as { index?: { _index?: string; _id?: string } };
      const doc = JSON.parse(lines[i + 1] ?? '{}') as Record<string, unknown>;
      const entry = this.resolve(op.index?._index ?? '');
      if (!entry) {
        errors = true;
        items.push({ index: { _id: op.index?._id, status: 404, error: { type: 'index_not_found_exception' } } });
        continue;
      }
      const id = op.index?._id ?? String(Math.random());
      if (this.writeBlocked.has(entry.name)) {
        errors = true;
        items.push({ index: { _index: entry.name, _id: id, status: 429, error: writeBlockedError(entry.name) } });
        continue;
      }
      const failure = numericRangeFailure(entry, doc);
      if (failure) {
        errors = true;
        items.push({ index: { _index: op.index?._index, _id: id, status: 400, error: failure } });
        continue;
      }
      entry.documents.set(id, { id, source: doc, mapping: entry.mappings });
      items.push({ index: { _id: id, status: 201 } });
    }
    this.json(res, 200, { took: 0, errors, items });
  }

  private count(res: ServerResponse, target: string): void {
    const entries = this.resolveTargets(target.split(','));
    this.json(res, 200, { count: entries.reduce((sum, entry) => sum + entry.documents.size, 0) });
  }

  /** PUT /:index/_doc/:id — index one document through an index or alias */
  private indexDocument(res: ServerResponse, pathname: string, body: unknown): void {
    const parts = pathname.slice(1).split('/');
    const index = decodeURIComponent(parts[0] ?? '');
    const id = parts[2] ? decodeURIComponent(parts[2]) : undefined;
    const entry = this.resolve(index);
    if (!entry) {
      this.json(res, 404, notFound(index));
      return;
    }
    if (this.writeBlocked.has(entry.name)) {
      const cause = writeBlockedError(entry.name);
      this.json(res, 429, { error: { root_cause: [cause], ...cause }, status: 429 });
      return;
    }
    const docId = id ?? `doc-${entry.documents.size + 1}`;
    const source = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    entry.documents.set(docId, { id: docId, source, mapping: entry.mappings });
    this.json(res, 201, { _index: index, _id: docId, result: 'created', _shards: { successful: 1, failed: 0 } });
  }

  private deleteByQuery(res: ServerResponse, target: string, body: unknown): void {
    const query = (body ?? {}) as { query?: Record<string, unknown> };
    let deleted = 0;
    for (const entry of this.resolveTargets(target.split(','))) {
      if (query.query === undefined) {
        deleted += entry.documents.size;
        entry.documents.clear();
        continue;
      }
      for (const [id, doc] of [...entry.documents]) {
        if (this.matches(doc, query.query)) {
          entry.documents.delete(id);
          deleted += 1;
        }
      }
    }
    this.json(res, 200, { deleted });
  }

  /** POST /:target/_search: the names come from the URL, comma-separated, the flags from its query string */
  private search(res: ServerResponse, target: string, body: SearchBody, params: URLSearchParams): void {
    const answer = this.runSearch(target.split(','), body, params.get('allow_partial_search_results') !== 'false');
    this.json(res, answer.status, answer.body);
  }

  /**
   * POST /_msearch: one answer per header and body pair, under `responses`. A
   * search the cluster refuses fails its own item, `{ error, status }`, while
   * the request itself answers 200, which is how a cluster answers too.
   */
  private msearch(res: ServerResponse, pairs: unknown): void {
    if (!Array.isArray(pairs)) {
      throw new Error('an _msearch body has to be NDJSON');
    }
    const responses = (pairs as MsearchPair[]).map(({ header, body }) => {
      const answer = this.runSearch(msearchTargets(header), body, header.allow_partial_search_results !== false);
      return { ...answer.body, status: answer.status };
    });
    this.json(res, 200, { took: 0, responses });
  }

  /**
   * One search over the named indices and aliases, as the status and body a
   * cluster answers. Every physical index is one shard, as the service's are:
   * the query phase ranks every match, then the fetch phase may fail a shard
   * over one of its page hits (fetchFailures). A failed shard's hits leave the
   * page and still count in the total of a 200; when every shard failed, or
   * the request refused partial results, the search answers 400.
   */
  private runSearch(names: string[], body: SearchBody, allowPartial: boolean): SearchAnswer {
    this.searches.push({ index: names, body: body as Record<string, unknown> });
    const from = body.from ?? 0;
    const size = body.size ?? 10;
    if (from + size > RESULT_WINDOW) {
      return { status: 400, body: resultWindowError(names.join(','), from + size) };
    }
    const query = body.query ?? {};
    const shards = [...new Set(this.resolveTargets(names))];
    const scored = shards
      .flatMap((shard) => [...shard.documents.values()].map((doc) => ({ doc, shard })))
      .filter(({ doc }) => this.matches(doc, query))
      .map((hit) => ({ ...hit, score: this.score(hit.doc, query) }))
      .sort((a, b) => this.compare(a, b, body.sort));
    const failures = this.fetchFailures(scored.slice(from, from + size), body);
    if (failures.length > 0 && (failures.length === shards.length || !allowPartial)) {
      const reason = failures.length === shards.length ? 'all shards failed' : 'Partial shards failure';
      return { status: 400, body: searchPhaseError('fetch', reason, failures) };
    }
    const failed = new Set(failures.map((failure) => failure.index));
    const page = scored.slice(from, from + size).filter(({ shard }) => !failed.has(shard.name));
    const excludes = new Set<string>(
      body._source && typeof body._source === 'object' ? (body._source.excludes ?? []) : [],
    );

    return {
      status: 200,
      body: {
        took: 0,
        _shards: shardStatistics(shards.length, failures),
        hits: {
          total: { value: scored.length, relation: 'eq' },
          hits: page.map(({ doc, score }) => ({
            _id: doc.id,
            _score: score,
            _source: Object.fromEntries(Object.entries(doc.source).filter(([key]) => !excludes.has(key))),
            ...this.highlight(doc, body),
          })),
        },
        ...this.aggregations(
          scored.map(({ doc }) => doc),
          body,
        ),
      },
    };
  }

  /**
   * The shards whose fetch phase fails for this page. The highlighter refuses
   * a field longer than index.highlight.max_analyzed_offset unless the request
   * caps it at that limit or below, and one refused field fails the fetch of
   * its whole shard, the other page hits of that shard included.
   */
  private fetchFailures(page: Array<{ doc: DocumentEntry; shard: IndexEntry }>, body: SearchBody): ShardFailure[] {
    const highlight = body.highlight;
    if (!highlight || analyzedLength(highlight) !== null) {
      return [];
    }
    const fields = Object.keys(highlight.fields ?? {}).map((spec) => this.fieldKey(spec));
    const failures = new Map<string, ShardFailure>();
    for (const { doc, shard } of page) {
      const tooLong = fields.find((field) => String(doc.source[field] ?? '').length > INDEX_MAX_ANALYZED_OFFSET);
      if (tooLong !== undefined && !failures.has(shard.name)) {
        failures.set(shard.name, analyzedOffsetFailure(shard.name, tooLong, String(doc.source[tooLong]).length));
      }
    }
    return [...failures.values()];
  }

  /** Minimal terms aggregations over the matched documents (channel facets) */
  private aggregations(docs: DocumentEntry[], body: SearchBody): Record<string, unknown> {
    const aggs = (body as { aggs?: Record<string, unknown> }).aggs;
    if (!aggs) {
      return {};
    }
    return { aggregations: this.runAggregations(docs, aggs) };
  }

  /**
   * One terms bucket list per named aggregation. A definition may carry its
   * own `aggs`: each bucket then runs those against the documents it holds,
   * which is how the console asks for the channel of every folder in one
   * query.
   */
  private runAggregations(docs: DocumentEntry[], aggs: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [name, definition] of Object.entries(aggs)) {
      const terms = (definition ?? {}) as TermsDefinition;
      result[name] = {
        doc_count_error_upper_bound: 0,
        sum_other_doc_count: 0,
        buckets: this.termsBuckets(docs, terms),
      };
    }
    return result;
  }

  /** The buckets of one terms aggregation: most frequent value first */
  private termsBuckets(docs: DocumentEntry[], terms: TermsDefinition): Array<Record<string, unknown>> {
    return [...this.bucketByField(docs, terms.terms?.field ?? '').entries()]
      .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
      .slice(0, terms.terms?.size ?? 10)
      .map(([key, bucketDocs]) => ({
        key,
        doc_count: bucketDocs.length,
        ...(terms.aggs === undefined ? {} : this.runAggregations(bucketDocs, terms.aggs)),
      }));
  }

  /**
   * The documents grouped by the value one field holds. A field the index does
   * not map groups nothing, which is what the cluster does with it.
   */
  private bucketByField(docs: DocumentEntry[], requested: string): Map<string, DocumentEntry[]> {
    const byValue = new Map<string, DocumentEntry[]>();
    for (const doc of docs) {
      const field = this.aggregationField(doc, requested);
      const value = field === undefined ? undefined : doc.source[field];
      if (typeof value !== 'string' || value.length === 0) {
        continue;
      }
      const bucket = byValue.get(value);
      if (bucket === undefined) {
        byValue.set(value, [doc]);
      } else {
        bucket.push(doc);
      }
    }
    return byValue;
  }

  /**
   * The document field an aggregation reads, or undefined when the index does
   * not map the requested name.
   *
   * A cluster buckets a mapped field, and answers an unmapped one with no
   * buckets rather than an error. `folderPath.keyword` is the case that hid a
   * broken folder map for months: the field does not exist, so the buckets
   * were empty and nothing complained.
   */
  private aggregationField(doc: DocumentEntry, requested: string): string | undefined {
    const [base, subfield] = requested.split('^')[0]?.split('.') ?? [];
    if (base === undefined) {
      return undefined;
    }
    const property = mappingProperties(doc.mapping)[base];
    if (property === undefined) {
      return undefined;
    }
    if (subfield === undefined) {
      return base;
    }
    return property.fields?.[subfield] === undefined ? undefined : base;
  }

  private matches(doc: DocumentEntry, query: Record<string, unknown>): boolean {
    const { multi_match: multi, bool } = query as {
      multi_match?: { query?: string; fields?: string[]; fuzziness?: unknown };
      bool?: BoolQuery;
    };
    if (bool) {
      return this.matchesBool(doc, bool);
    }
    if (multi) {
      const terms = termsOf(multi.query ?? '');
      if (terms.length === 0) {
        return true;
      }
      const fields = (multi.fields ?? []).map((field) => this.fieldKey(field));
      // best_fields with Elasticsearch's default operator: one term in one
      // field is enough, compared against analysed tokens rather than raw
      // substrings, with the edit budget the request asked for.
      return terms.some((term) => {
        const budget = fuzzinessBudget(term, multi.fuzziness);
        return fields.some((field) => holdsTerm(String(doc.source[field] ?? ''), term, budget));
      });
    }
    const clause = Object.entries(query)[0];
    if (!clause) {
      return true; // match_all
    }
    return this.matchesClause(doc, clause as [string, unknown]);
  }

  /**
   * A bool query the way a cluster reads it: every must and filter clause,
   * and at least `minimum_should_match` of the should clauses. That minimum
   * defaults to one for a should list on its own and to none next to a must
   * or filter clause. getVideoByFilePath sends a should list, which the fake
   * used to drop, so every file name resolved to the first video. Keys the
   * service never sends, must_not among them, are refused rather than guessed.
   */
  private matchesBool(doc: DocumentEntry, bool: BoolQuery): boolean {
    const unmodelled = Object.keys(bool).find((key) => !BOOL_KEYS.has(key));
    if (unmodelled !== undefined) {
      throw new Error(`bool.${unmodelled} is not modelled`);
    }
    const required = [...(bool.must ?? []), ...(bool.filter ?? [])];
    const should = bool.should ?? [];
    const minimum = bool.minimum_should_match ?? (should.length > 0 && required.length === 0 ? 1 : 0);
    if (!Number.isInteger(minimum) || minimum < 0) {
      throw new Error(`bool.minimum_should_match ${JSON.stringify(minimum)} is not modelled`);
    }
    if (required.some((clause) => !this.matches(doc, clause))) {
      return false;
    }
    return should.filter((clause) => this.matches(doc, clause)).length >= minimum;
  }

  private matchesClause(doc: DocumentEntry, [clauseType, clauseBody]: [string, unknown]): boolean {
    if (clauseType === 'match_all') {
      return true;
    }
    if (clauseType === 'term') {
      return this.matchesTerm(doc, clauseBody);
    }
    if (clauseType === 'range') {
      return this.matchesRange(doc, clauseBody);
    }
    if (clauseType === 'ids') {
      // The details-by-id lookup depends on this: a folder holding many
      // videos must still resolve the one document with the requested id.
      const values = (clauseBody ?? {}) as { values?: unknown };
      return Array.isArray(values.values) && values.values.includes(doc.id);
    }
    // Refused rather than kept: a clause the fake ignores widens the answer,
    // and a test reading a wider answer than a cluster gives can still pass
    throw new Error(`the ${clauseType} query is not modelled`);
  }

  private matchesTerm(doc: DocumentEntry, clauseBody: unknown): boolean {
    const entry = Object.entries((clauseBody ?? {}) as Record<string, unknown>)[0];
    if (!entry) {
      return false;
    }
    const [field, fieldValue] = entry as [string, unknown];
    // ES accepts both { field: value } and { field: { value } }
    const value =
      typeof fieldValue === 'object' && fieldValue !== null ? (fieldValue as { value?: unknown }).value : fieldValue;
    const source = this.termField(doc, field);
    return source !== undefined && doc.source[source] === value;
  }

  /**
   * The document field a term query compares, resolved through the stored
   * mapping the way aggregationField resolves one: a name the mapping does not
   * declare, subfield included, matches nothing, as on a cluster
   * (`videoPath.keyword` does not exist). Only keyword fields are modelled. On
   * a cluster a term on an analysed field matches only a value equal to one of
   * its lowercased tokens, so it is refused instead of being compared with the
   * raw text; every term the service sends targets a keyword field.
   */
  private termField(doc: DocumentEntry, requested: string): string | undefined {
    const source = this.aggregationField(doc, requested);
    if (source === undefined) {
      return undefined;
    }
    const property = mappingProperties(doc.mapping)[source];
    const subfield = requested.split('.')[1];
    const type = subfield === undefined ? property?.type : property?.fields?.[subfield]?.type;
    if (type !== 'keyword') {
      throw new Error(`a term query on the ${type ?? 'untyped'} field ${requested} is not modelled`);
    }
    return source;
  }

  private matchesRange(doc: DocumentEntry, clauseBody: unknown): boolean {
    const entry = Object.entries((clauseBody ?? {}) as Record<string, unknown>)[0];
    if (!entry) {
      return false;
    }
    const [field, bounds] = entry as [string, { gte?: string; lte?: string }];
    const value = String(doc.source[field] ?? '');
    if (bounds.gte !== undefined && value < bounds.gte) {
      return false;
    }
    if (bounds.lte !== undefined && value > bounds.lte) {
      return false;
    }
    return true;
  }

  private fieldKey(field: string): string {
    return (field.split('^')[0] ?? field).replace(/\.text$/, '').replace(/\.keyword$/, '');
  }

  /**
   * A document's score: for a multi_match, the field weights of the terms it
   * holds, with no IDF; for a bool query, the sum over the must clauses and
   * the should clauses it matches, the way a cluster adds them up, while a
   * filter narrows and scores nothing. Every other clause scores 1. The page
   * search sends its phrase as a bool of two multi_match clauses, which the
   * fake used to score 1 throughout, so no field weight decided a page.
   */
  private score(doc: DocumentEntry, query: Record<string, unknown>): number {
    const { multi_match: multi, bool } = query as {
      multi_match?: { query?: string; fields?: string[] };
      bool?: BoolQuery;
    };
    if (bool) {
      const scoring = [...(bool.must ?? []), ...(bool.should ?? []).filter((clause) => this.matches(doc, clause))];
      return scoring.reduce((sum, clause) => sum + this.score(doc, clause), 0);
    }
    if (!multi) {
      return 1;
    }
    const terms = termsOf(multi.query ?? '');
    let score = 0;
    for (const field of multi.fields ?? []) {
      const weight = Number(field.split('^')[1] ?? 1);
      const text = fold(String(doc.source[this.fieldKey(field)] ?? ''));
      score += weight * terms.filter((term) => text.includes(term)).length;
    }
    return score;
  }

  private compare(
    a: { doc: DocumentEntry; score: number },
    b: { doc: DocumentEntry; score: number },
    sort: unknown,
  ): number {
    const clauses = Array.isArray(sort) ? (sort as unknown[]) : [];
    if (clauses.length === 0) {
      return b.score - a.score;
    }
    const clauseEntry = Object.entries(clauses[0] as Record<string, { order?: string; missing?: string }>)[0];
    if (!clauseEntry) {
      return b.score - a.score;
    }
    const [field, spec] = clauseEntry;
    const av = a.doc.source[field];
    const bv = b.doc.source[field];
    if (av === undefined && bv === undefined) {
      return b.score - a.score;
    }
    if (av === undefined) {
      return 1; // missing last
    }
    if (bv === undefined) {
      return -1;
    }
    const cmp = compareValues(av, bv);
    return spec.order === 'asc' ? cmp : -cmp;
  }

  private highlight(doc: DocumentEntry, body: SearchBody): Record<string, unknown> {
    const highlight = body.highlight;
    if (!highlight) {
      return {};
    }
    const terms = phraseTermsOf(body.query);
    if (terms.length === 0) {
      return {};
    }
    const tags = { open: highlight.pre_tags?.[0] ?? '', close: highlight.post_tags?.[0] ?? '' };
    // A capped request analyzes only the start of each field, so a match past
    // the cap leaves the hit without a fragment from that field
    const limit = analyzedLength(highlight);
    const result: Record<string, string[]> = {};
    for (const fieldSpec of Object.keys(highlight.fields ?? {})) {
      const field = this.fieldKey(fieldSpec);
      const whole = String(doc.source[field] ?? '');
      const text = limit === null ? whole : whole.slice(0, limit);
      const marked = markTerms(text, terms, tags);
      if (marked !== text) {
        result[field] = [marked];
      }
    }
    return { highlight: result };
  }
}

/**
 * The words a query highlights: those of its multi_match clauses, at any depth
 * of bool must and should. The page search sends its phrase as a bool of two
 * multi_match clauses, nested in a must next to a channel filter, and a
 * cluster highlights their words as it would a bare multi_match.
 */
function phraseTermsOf(query: unknown): string[] {
  const { multi_match: multi, bool } = (query ?? {}) as { multi_match?: { query?: string }; bool?: BoolQuery };
  if (multi) {
    return termsOf(multi.query ?? '');
  }
  if (bool) {
    return [...new Set([...(bool.must ?? []), ...(bool.should ?? [])].flatMap((clause) => phraseTermsOf(clause)))];
  }
  return [];
}

/**
 * Two sort values in ascending order. Numbers compare by value, the way a
 * cluster sorts a numeric field: compared as text, 999 ranked above
 * 3000000000. Everything else, the keyword dates included, compares as text.
 */
function compareValues(left: unknown, right: unknown): number {
  if (typeof left === 'number' && typeof right === 'number') {
    return Math.sign(left - right);
  }
  const [a, b] = [String(left), String(right)];
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The text with one occurrence of each query term wrapped in the highlight tags */
function markTerms(text: string, terms: string[], tags: { open: string; close: string }): string {
  let marked = text;
  for (const term of terms) {
    const index = fold(text).indexOf(term);
    if (index >= 0) {
      marked = `${text.slice(0, index)}${tags.open}${text.slice(index, index + term.length)}${tags.close}${text.slice(index + term.length)}`;
    }
  }
  return marked;
}
