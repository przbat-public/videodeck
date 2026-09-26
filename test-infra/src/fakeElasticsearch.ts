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
 *   any bulk item failed").
 *
 * Search still implements only the query shapes the service sends
 * (multi_match over SEARCH_FIELDS, bool filters, uploadDate/viewCount/
 * likeCount sorts, highlight fragments with the service's control chars).
 * Everything else the real-ES CI integration suite covers against an actual
 * cluster.
 */

interface DocumentEntry {
  id: string;
  source: Record<string, unknown>;
}

interface IndexEntry {
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
  };
  _source?: { excludes?: string[] } | boolean;
}

/**
 * Letters Lucene's ASCIIFoldingFilter folds to ASCII while Unicode NFD leaves
 * them alone. The real index analyzer is `standard` + lowercase +
 * asciifolding, so `ł` has to search as `l`; Polish needs that one, and the
 * rest of the table covers the usual European letters.
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

/** The 400 body a real cluster answers a page past the window with */
function resultWindowError(target: string, requested: number): Record<string, unknown> {
  const reason =
    `Result window is too large, from + size must be less than or equal to: [${RESULT_WINDOW}] but was [${requested}]. ` +
    'See the scroll api for a more efficient way to request large data sets. This limit can be set by changing the ' +
    '[index.max_result_window] index level setting.';
  return {
    error: {
      root_cause: [{ type: 'illegal_argument_exception', reason }],
      type: 'search_phase_execution_exception',
      reason: 'all shards failed',
      phase: 'query',
      grouped: true,
      failed_shards: [
        { shard: 0, index: target, node: 'fake-node', reason: { type: 'illegal_argument_exception', reason } },
      ],
    },
    status: 400,
  };
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

function readJsonBody(req: IncomingMessage, rawBody: string): unknown {
  if (req.headers['content-type']?.includes('ndjson')) {
    return rawBody;
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
  /** Parsed JSON body when the request carried one */
  body?: unknown;
}

export class FakeElasticsearch {
  private readonly indices = new Map<string, IndexEntry>();
  private readonly aliases = new Map<string, string>();
  private readonly requests: FakeEsRequest[] = [];
  private readonly faults: Array<{ match: string | RegExp; status: number }> = [];
  private server: Server | null = null;
  private port: number | null = null;

  /** Every request the app sent, in order (assertions on search bodies) */
  get requestLog(): FakeEsRequest[] {
    return [...this.requests];
  }

  /** Answer requests whose path contains the substring with this status */
  failRequestsMatching(match: string | RegExp, status: number): void {
    this.faults.push({ match, status });
  }

  clearFailures(): void {
    this.faults.length = 0;
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

  private resolveTargets(target: string): IndexEntry[] {
    const entries: IndexEntry[] = [];
    for (const name of target
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)) {
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
      const body = readJsonBody(req, rawBody);
      const [path, suffix] = splitPath(url.pathname);
      const name = suffix !== undefined ? decodeURIComponent(path) : decodeURIComponent(url.pathname.slice(1));

      this.requests.push({
        method: req.method ?? 'GET',
        path: url.pathname + url.search,
        ...(body === undefined ? {} : { body }),
      });

      const target = url.pathname + url.search;
      const fault = this.faults.find((entry) =>
        typeof entry.match === 'string' ? target.includes(entry.match) : entry.match.test(target),
      );
      if (fault) {
        this.json(res, fault.status, { error: { type: 'fake-fault', status: fault.status } });
        return;
      }

      if (!this.handleWellKnownRoutes(req, res, url, name, suffix, body)) {
        this.handleNamedRoutes(req, res, name, body);
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
    if (url.pathname === '/_cluster/health') {
      this.json(res, 200, { status: 'green' });
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
    if (suffix === '_search') {
      this.search(res, name, body as SearchBody);
      return true;
    }
    if (suffix === '_count') {
      this.count(res, name);
      return true;
    }
    if (suffix === '_delete_by_query') {
      this.deleteByQuery(res, name);
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
  private handleNamedRoutes(req: IncomingMessage, res: ServerResponse, name: string, body: unknown): void {
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
        const mappings = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
        this.indices.set(name, { documents: new Map(), mappings });
        this.json(res, 200, { acknowledged: true, index: name });
        return;
      }
      case 'DELETE': {
        this.indices.delete(name);
        for (const [alias, index] of this.aliases) {
          if (index === name) {
            this.aliases.delete(alias);
          }
        }
        this.json(res, 200, { acknowledged: true });
        return;
      }
      default:
        this.json(res, 405, { error: `fake-elasticsearch: unsupported ${req.method}` });
    }
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
      entry.documents.set(id, { id, source: doc });
      items.push({ index: { _id: id, status: 201 } });
    }
    this.json(res, 200, { took: 0, errors, items });
  }

  private count(res: ServerResponse, target: string): void {
    this.json(res, 200, { count: this.resolveTargets(target).reduce((sum, entry) => sum + entry.documents.size, 0) });
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
    const docId = id ?? `doc-${entry.documents.size + 1}`;
    const source = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    entry.documents.set(docId, { id: docId, source });
    this.json(res, 201, { _index: index, _id: docId, result: 'created', _shards: { successful: 1, failed: 0 } });
  }

  private deleteByQuery(res: ServerResponse, target: string): void {
    let deleted = 0;
    for (const entry of this.resolveTargets(target)) {
      deleted += entry.documents.size;
      entry.documents.clear();
    }
    this.json(res, 200, { deleted });
  }

  private search(res: ServerResponse, target: string, body: SearchBody): void {
    const from = body.from ?? 0;
    const size = body.size ?? 10;
    if (from + size > RESULT_WINDOW) {
      this.json(res, 400, resultWindowError(target, from + size));
      return;
    }
    const sources = this.resolveTargets(target).flatMap((entry) => [...entry.documents.values()]);
    const matches = sources.filter((doc) => this.matches(doc, body.query ?? {}));
    const scored = matches
      .map((doc) => ({ doc, score: this.score(doc, body.query ?? {}) }))
      .sort((a, b) => this.compare(a, b, body.sort));
    const page = scored.slice(from, from + size);
    const excludes = new Set<string>(
      body._source && typeof body._source === 'object' ? (body._source.excludes ?? []) : [],
    );

    this.json(res, 200, {
      took: 0,
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
    });
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
      const terms = (definition ?? {}) as {
        terms?: { field?: string; size?: number };
        aggs?: Record<string, unknown>;
      };
      const field = this.fieldKey(terms.terms?.field ?? '');
      const byValue = new Map<string, DocumentEntry[]>();
      for (const doc of docs) {
        const value = doc.source[field];
        if (typeof value === 'string' && value.length > 0) {
          const bucket = byValue.get(value);
          if (bucket === undefined) {
            byValue.set(value, [doc]);
          } else {
            bucket.push(doc);
          }
        }
      }
      const buckets = [...byValue.entries()]
        .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
        .slice(0, terms.terms?.size ?? 10)
        .map(([key, bucketDocs]) => ({
          key,
          doc_count: bucketDocs.length,
          ...(terms.aggs === undefined ? {} : this.runAggregations(bucketDocs, terms.aggs)),
        }));
      result[name] = { doc_count_error_upper_bound: 0, sum_other_doc_count: 0, buckets };
    }
    return result;
  }

  private matches(doc: DocumentEntry, query: Record<string, unknown>): boolean {
    const { multi_match: multi, bool } = query as {
      multi_match?: { query?: string; fields?: string[] };
      bool?: { must?: unknown[]; filter?: unknown[] };
    };
    if (bool) {
      const must = (bool.must ?? []).map((clause) => clause as Record<string, unknown>);
      const filter = (bool.filter ?? []).map((clause) => clause as Record<string, unknown>);
      if (must.some((clause) => !this.matches(doc, clause))) {
        return false;
      }
      if (filter.some((clause) => !this.matches(doc, clause))) {
        return false;
      }
      return true;
    }
    if (multi) {
      const terms = termsOf(multi.query ?? '');
      if (terms.length === 0) {
        return true;
      }
      const fields = (multi.fields ?? []).map((field) => this.fieldKey(field));
      return terms.every((term) => fields.some((field) => fold(String(doc.source[field] ?? '')).includes(term)));
    }
    const clause = Object.entries(query)[0];
    if (!clause) {
      return true; // match_all
    }
    return this.matchesClause(doc, clause as [string, unknown]);
  }

  private matchesClause(doc: DocumentEntry, [clauseType, clauseBody]: [string, unknown]): boolean {
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
    return true; // unknown clauses keep the document (behaviour fidelity is not the goal here)
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
    return doc.source[this.fieldKey(field)] === value;
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

  private score(doc: DocumentEntry, query: Record<string, unknown>): number {
    const multi = (query as { multi_match?: { query?: string; fields?: string[] } }).multi_match;
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
    const cmp = String(av) < String(bv) ? -1 : String(av) > String(bv) ? 1 : 0;
    return spec.order === 'asc' ? cmp : -cmp;
  }

  private highlight(doc: DocumentEntry, body: SearchBody): Record<string, unknown> {
    const highlight = body.highlight;
    if (!highlight) {
      return {};
    }
    const multi = (body.query as { multi_match?: { query?: string } }).multi_match;
    const terms = termsOf(multi?.query ?? '');
    if (terms.length === 0) {
      return {};
    }
    const open = highlight.pre_tags?.[0] ?? '';
    const close = highlight.post_tags?.[0] ?? '';
    const result: Record<string, string[]> = {};
    for (const fieldSpec of Object.keys(highlight.fields ?? {})) {
      const field = this.fieldKey(fieldSpec);
      const text = String(doc.source[field] ?? '');
      let marked = text;
      for (const term of terms) {
        const index = fold(text).indexOf(term);
        if (index >= 0) {
          marked = `${text.slice(0, index)}${open}${text.slice(index, index + term.length)}${close}${text.slice(index + term.length)}`;
        }
      }
      if (marked !== text) {
        result[field] = [marked];
      }
    }
    return { highlight: result };
  }
}
