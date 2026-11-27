import { FakeElasticsearch } from '@videodeck/test-infra/fakeElasticsearch';

/**
 * Pins the fake's test-controls surface: the request log, fault injection
 * and the alias/index state getters the journey tests assert on.
 */
describe('FakeElasticsearch controls', () => {
  let fake: FakeElasticsearch;
  let baseUrl: string;

  beforeAll(async () => {
    fake = new FakeElasticsearch();
    baseUrl = await fake.start();
    await fetch(`${baseUrl}/videos_x`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      // The mapping the range and term rules read, in the production shape: a
      // real index maps the counts as integer, so a value outside int32 is
      // refused per item, and the file names and the title's subfield as
      // keyword, which a term query compares raw.
      body: JSON.stringify({
        settings: {},
        mappings: {
          properties: {
            title: { type: 'text', fields: { keyword: { type: 'keyword' } } },
            videoPath: { type: 'keyword' },
            thumbnailPath: { type: 'keyword' },
            viewCount: { type: 'integer' },
          },
        },
      }),
    });
    // The alias is part of the fixture, not a leftover of the test that
    // happens to run before the alias tests: nothing here may need an order.
    await fetch(`${baseUrl}/_aliases`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actions: [{ add: { index: 'videos_x', alias: 'videos_alias' } }] }),
    });
  });

  afterAll(async () => {
    await fake.stop();
  });

  // Every test writes into the one fixture index, and a fuzzy query reaches a
  // neighbour's token ('betaunikat' is two edits from 'deltaunikat'), so each
  // test starts from an empty index. The mapping and the alias stay. The delete
  // is checked: one the fake refused would bring the leak back without a sound.
  beforeEach(async () => {
    const emptied = await fetch(`${baseUrl}/videos_x/_delete_by_query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: { match_all: {} } }),
    });
    expect(emptied.status).toBe(200);
  });

  const search = () =>
    fetch(`${baseUrl}/videos_x/_search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: { match_all: {} } }),
    });

  const searchPage = (from: number, size: number) =>
    fetch(`${baseUrl}/videos_x/_search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: { match_all: {} }, from, size }),
    });

  /** `_bulk` NDJSON: alternating action and document lines */
  const bulk = (lines: unknown[]) =>
    fetch(`${baseUrl}/_bulk`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-ndjson' },
      body: `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
    });

  it('logs every request with method, path and parsed body', async () => {
    await search();
    const last = fake.requestLog.at(-1);
    expect(last?.method).toBe('POST');
    expect(last?.path).toBe('/videos_x/_search');
    expect(last?.body).toEqual({ query: { match_all: {} } });
  });

  it('answers faulted paths with the injected status until cleared', async () => {
    fake.failRequestsMatching('/_search', 503);
    expect((await search()).status).toBe(503);
    fake.clearFailures();
    expect((await search()).status).toBe(200);
  });

  it('tracks alias switches and physical index names', async () => {
    await fetch(`${baseUrl}/_aliases`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actions: [{ add: { index: 'videos_x', alias: 'videos_alias' } }] }),
    });
    expect(fake.aliasOf('videos_alias')).toBe('videos_x');
    expect(fake.indexNames()).toContain('videos_x');
  });

  it('indexes single documents through PUT /:index/_doc/:id', async () => {
    const response = await fetch(`${baseUrl}/videos_alias/_doc/abc123?refresh=true`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Fake video abc123' }),
    });
    expect(response.status).toBe(201);

    const search = await fetch(`${baseUrl}/videos_alias/_search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: { multi_match: { query: 'abc123', fields: ['title'] } } }),
    });
    const hits = ((await search.json()) as { hits: { hits: Array<{ _id: string }> } }).hits.hits;
    expect(hits).toHaveLength(1);
    expect(hits[0]?._id).toBe('abc123');
  });

  it('answers alias existence checks on /_alias/<name>', async () => {
    // The official client probes existsAlias with HEAD /_alias/<name>; a
    // missing alias answers 404 (false), a live one answers 200 (true).
    const missing = await fetch(`${baseUrl}/_alias/videos_missing`, { method: 'HEAD' });
    expect(missing.status).toBe(404);

    const existing = await fetch(`${baseUrl}/_alias/videos_alias`, { method: 'HEAD' });
    expect(existing.status).toBe(200);

    const response = await fetch(`${baseUrl}/_alias/videos_alias`);
    expect(((await response.json()) as Record<string, unknown>).videos_x).toBeDefined();
  });

  it('folds diacritics the way the real analyzer does, including ł', async () => {
    // The index analyzer is standard + lowercase + asciifolding. Unicode NFD
    // handles ę/ą/ó but leaves ł alone, and a fake that stops there answers
    // empty for a query the real cluster matches.
    await fetch(`${baseUrl}/videos_x/_doc/polish1?refresh=true`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Głęboka integracja', channelName: 'Kanał Łódź' }),
    });

    const hitsFor = async (query: string, field: string): Promise<number> => {
      const response = await fetch(`${baseUrl}/videos_x/_search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: { multi_match: { query, fields: [field] } } }),
      });
      const body = (await response.json()) as { hits: { total: { value: number } } };
      return body.hits.total.value;
    };

    expect(await hitsFor('gleboka', 'title')).toBe(1); // ę folds through NFD
    expect(await hitsFor('lodz', 'channelName')).toBe(1); // ł only through the table
    expect(await hitsFor('gleboka integracja', 'title')).toBe(1);
    expect(await hitsFor('kosmosu', 'title')).toBe(0);
  });

  it('buckets a terms aggregation only on a field the index mapping declares', async () => {
    // The mapping the server writes: folderPath is a keyword, channelName is
    // text with a keyword subfield. A cluster buckets the first two names and
    // answers an unmapped field with no buckets at all, never an error, which
    // is how `folderPath.keyword` stayed silent for so long.
    await fetch(`${baseUrl}/videos_agg`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        settings: {},
        mappings: {
          properties: {
            folderPath: { type: 'keyword' },
            channelName: { type: 'text', fields: { keyword: { type: 'keyword' } } },
          },
        },
      }),
    });
    await bulk([
      { index: { _index: 'videos_agg', _id: 'agg1' } },
      { folderPath: '/videos/a', channelName: 'Alpha' },
      { index: { _index: 'videos_agg', _id: 'agg2' } },
      { folderPath: '/videos/b', channelName: 'Beta' },
    ]);

    const bucketsFor = async (field: string): Promise<string[]> => {
      const response = await fetch(`${baseUrl}/videos_agg/_search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ size: 0, aggs: { by: { terms: { field } } } }),
      });
      const body = (await response.json()) as { aggregations: { by: { buckets: Array<{ key: string }> } } };
      return body.aggregations.by.buckets.map((bucket) => bucket.key);
    };

    expect(await bucketsFor('folderPath')).toEqual(['/videos/a', '/videos/b']);
    expect(await bucketsFor('channelName.keyword')).toEqual(['Alpha', 'Beta']);
    expect(await bucketsFor('folderPath.keyword')).toEqual([]);
    expect(await bucketsFor('unmapped')).toEqual([]);
  });

  it('refuses a page past the result window the way Elasticsearch does', async () => {
    // A real cluster rejects `from + size > index.max_result_window` (10000 by
    // default) with this 400 body; a fake that slices happily hides the bug.
    const response = await searchPage(9990, 20);

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: {
        type: string;
        reason: string;
        root_cause: Array<{ type: string; reason: string }>;
        failed_shards: Array<{ reason: { type: string } }>;
      };
      status: number;
    };
    expect(body.error.type).toBe('search_phase_execution_exception');
    expect(body.error.reason).toBe('all shards failed');
    expect(body.error.root_cause[0]?.type).toBe('illegal_argument_exception');
    expect(body.error.root_cause[0]?.reason).toContain('Result window is too large');
    expect(body.error.root_cause[0]?.reason).toContain('[10000] but was [10010]');
    expect(body.error.failed_shards[0]?.reason.type).toBe('illegal_argument_exception');
    expect(body.status).toBe(400);
  });

  it('still serves a page that ends exactly at the result window', async () => {
    expect((await searchPage(9900, 100)).status).toBe(200);
  });

  it('reports errors: false when every bulk item succeeded', async () => {
    const response = await bulk([{ index: { _index: 'videos_x', _id: 'bulk-ok' } }, { title: 'Stored' }]);

    const body = (await response.json()) as { errors: boolean; items: Array<{ index: { status: number } }> };
    expect(body.errors).toBe(false);
    expect(body.items[0]?.index.status).toBe(201);
  });

  it('reports errors: true when any bulk item failed', async () => {
    // The service decides per item off `errors`; a fake that always says false
    // lets a caller count a document the cluster refused as indexed. The
    // refusal here comes from the mapping, which is how a real cluster answers
    // a hand-edited info.json whose count no longer fits an integer.
    const response = await bulk([
      { index: { _index: 'videos_x', _id: 'bulk-ok-2' } },
      { title: 'Stored', viewCount: 12 },
      { index: { _index: 'videos_x', _id: 'bulk-bad' } },
      { title: 'Out of range', viewCount: 100_000_000_000_000_000_000 },
    ]);

    const body = (await response.json()) as {
      errors: boolean;
      items: Array<{ index: { status: number; error?: { type: string } } }>;
    };
    expect(body.errors).toBe(true);
    expect(body.items[0]?.index.status).toBe(201);
    expect(body.items[1]?.index.status).toBe(400);
    expect(body.items[1]?.index.error?.type).toBe('document_parsing_exception');
  });

  it('refuses a bulk item whose index does not exist', async () => {
    // A default cluster auto-creates the index and reports the item as
    // created, so the fake is stricter than reality here on purpose: the
    // service creates its target index before writing, and a 404 catches the
    // caller that forgot to.
    const response = await bulk([
      { index: { _index: 'videos_x', _id: 'bulk-ok-3' } },
      { title: 'Stored' },
      { index: { _index: 'videos_missing', _id: 'bulk-bad-2' } },
      { title: 'No such index' },
    ]);

    const body = (await response.json()) as { errors: boolean; items: Array<{ index: { status: number } }> };
    expect(body.errors).toBe(true);
    expect(body.items[1]?.index.status).toBe(404);
  });

  /** One document in the fixture index, refreshed so the next search sees it */
  const putDocument = (id: string, source: Record<string, unknown>) =>
    fetch(`${baseUrl}/videos_x/_doc/${id}?refresh=true`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(source),
    });

  /** How many documents one analysed multi_match query matches */
  const matchesFor = async (query: string, field: string): Promise<number> => {
    const response = await fetch(`${baseUrl}/videos_x/_search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: { multi_match: { query, fields: [field], fuzziness: 'AUTO' } } }),
    });
    const body = (await response.json()) as { hits: { total: { value: number } } };
    return body.hits.total.value;
  };

  it('matches any of the query terms, the way best_fields with the default operator does', async () => {
    // Invented tokens, and the index starts empty, so the count cannot depend
    // on what another test wrote.
    await putDocument('operator-or-1', { title: 'Alfaunikat' });
    await putDocument('operator-or-2', { title: 'Betaunikat' });

    // Elasticsearch's default operator is or, so a document holding one of the
    // terms matches. The fake required all of them, which made a multi-word
    // query the real cluster answers come back empty here.
    expect(await matchesFor('alfaunikat betaunikat', 'title')).toBe(2);
  });

  it('matches whole tokens rather than substrings', async () => {
    await putDocument('token-1', { title: 'Gammaunikat' });

    // Inside the token, and three edits away from an eleven-character one,
    // while a seven-character term gets a fuzziness budget of two
    expect(await matchesFor('maunikat', 'title')).toBe(0);
  });

  it('tolerates a typo inside the fuzziness AUTO budget', async () => {
    await putDocument('typo-1', { title: 'Deltaunikat' });

    // One insertion, and a term longer than five characters gets a budget of two
    expect(await matchesFor('deltauniikat', 'title')).toBe(1);
  });

  it('refuses a typo outside the fuzziness AUTO budget', async () => {
    await putDocument('typo-2', { title: 'Zetatrafore' });

    // Four characters get a budget of one, and 'zeta' is five edits from
    // 'zetatrafore': the substring match the fake used to do answered here
    expect(await matchesFor('zeta', 'title')).toBe(0);
  });

  it('empties an index for a match_all delete and keeps the index itself', async () => {
    await putDocument('clear-1', { title: 'Pierwszydokument' });

    const response = await fetch(`${baseUrl}/videos_x/_delete_by_query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: { match_all: {} } }),
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { deleted: number }).deleted).toBeGreaterThan(0);

    // The index survives (that is the difference from deleting it), so the next
    // incremental write does not have to rebuild it
    const head = await fetch(`${baseUrl}/videos_x`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await matchesFor('pierwszydokument', 'title')).toBe(0);
  });

  it('refuses to create an index that already exists, like the cluster', async () => {
    await putDocument('exists-1', { title: 'Trzymadokument' });

    const response = await fetch(`${baseUrl}/videos_x`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ settings: {}, mappings: {} }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { type: string } };
    expect(body.error.type).toBe('resource_already_exists_exception');

    // A refused create must not replace the index the fixture shares
    const total = ((await (await search()).json()) as { hits: { total: { value: number } } }).hits.total.value;
    expect(total).toBeGreaterThan(0);
  });

  it('answers index_not_found_exception when a missing index is deleted', async () => {
    const missing = await fetch(`${baseUrl}/videos_missing`, { method: 'DELETE' });
    expect(missing.status).toBe(404);
    const body = (await missing.json()) as { error: { type: string } };
    expect(body.error.type).toBe('index_not_found_exception');

    // The flag the production deletes pass for a path that may already be gone
    const ignored = await fetch(`${baseUrl}/videos_missing?ignore_unavailable=true`, { method: 'DELETE' });
    expect(ignored.status).toBe(200);
  });

  it('deletes only the documents a delete_by_query matches', async () => {
    await putDocument('delete-keep', { title: 'Zostajetoken' });
    await putDocument('delete-drop', { title: 'Znikatoken' });

    const response = await fetch(`${baseUrl}/videos_x/_delete_by_query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // The keyword subfield: a term on the analysed title compares one
      // lowercased token on a cluster, which the fake refuses to guess
      body: JSON.stringify({ query: { term: { 'title.keyword': 'Znikatoken' } } }),
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { deleted: number }).deleted).toBe(1);

    expect(await matchesFor('zostajetoken', 'title')).toBe(1);
    expect(await matchesFor('znikatoken', 'title')).toBe(0);
  });

  it('finds a video by its video or thumbnail file name, and nothing for a name no video holds', async () => {
    await putDocument('file-a', { title: 'Plik A', videoPath: 'a.mp4', thumbnailPath: 'a.webp' });
    await putDocument('file-b', { title: 'Plik B', videoPath: 'b.mp4', thumbnailPath: 'b.webp' });

    // getVideoByFilePath's query (server/src/services/elasticsearch/search.ts),
    // size 1 as findOne asks. The fake used to drop the should list, so every
    // name matched every video and resolved to the first one.
    const byFileName = async (fileName: string) => {
      const response = await fetch(`${baseUrl}/videos_x/_search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          query: {
            bool: {
              should: [{ term: { videoPath: fileName } }, { term: { thumbnailPath: fileName } }],
              minimum_should_match: 1,
            },
          },
          size: 1,
        }),
      });
      const body = (await response.json()) as { hits: { total: { value: number }; hits: Array<{ _id: string }> } };
      return { total: body.hits.total.value, ids: body.hits.hits.map((hit) => hit._id) };
    };

    expect(await byFileName('b.mp4')).toEqual({ total: 1, ids: ['file-b'] });
    expect(await byFileName('a.webp')).toEqual({ total: 1, ids: ['file-a'] });
    expect(await byFileName('missing.mp4')).toEqual({ total: 0, ids: [] });

    // Without minimum_should_match a should list on its own still needs one
    // match, which is the cluster's default
    const unbounded = await fetch(`${baseUrl}/videos_x/_search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: { bool: { should: [{ term: { videoPath: 'b.mp4' } }] } } }),
    });
    expect(((await unbounded.json()) as { hits: { total: { value: number } } }).hits.total.value).toBe(1);
  });

  it('reads a should list next to must as optional, and refuses a minimum it does not model', async () => {
    await putDocument('should-1', { title: 'Opcjonalny', videoPath: 'opt.mp4' });
    const boolSearch = (bool: Record<string, unknown>) =>
      fetch(`${baseUrl}/videos_x/_search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: { bool } }),
      });

    // Next to must or filter, a cluster asks for none of the should clauses
    const optional = await boolSearch({ must: [{ match_all: {} }], should: [{ term: { videoPath: 'other.mp4' } }] });
    expect(((await optional.json()) as { hits: { total: { value: number } } }).hits.total.value).toBe(1);

    // A cluster also takes '1' or '75%'; the fake models whole numbers only,
    // and says so rather than guess
    const percent = await boolSearch({ should: [{ term: { videoPath: 'opt.mp4' } }], minimum_should_match: '75%' });
    expect(percent.status).toBe(500);
    expect(JSON.stringify(await percent.json())).toContain('minimum_should_match');
  });

  it('matches nothing for a term on a subfield the mapping does not declare', async () => {
    await putDocument('subfield-1', { title: 'Podpoledokument', videoPath: 'subfield.mp4' });

    const totalFor = async (field: string): Promise<number> => {
      const response = await fetch(`${baseUrl}/videos_x/_search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: { term: { [field]: 'subfield.mp4' } } }),
      });
      return ((await response.json()) as { hits: { total: { value: number } } }).hits.total.value;
    };

    // videoPath is a keyword with no subfields, so a cluster has no
    // videoPath.keyword to compare and answers no hits rather than an error,
    // the same silence folderPath.keyword got from the aggregation. The fake
    // used to fold the suffix away and match.
    expect(await totalFor('videoPath.keyword')).toBe(0);
    expect(await totalFor('videoPath')).toBe(1);
  });

  it('answers a query shape it does not model with a 500 that names it', async () => {
    await putDocument('shape-1', { title: 'Ksztaltdokument', videoPath: 'shape.mp4' });

    const searchFor = (query: Record<string, unknown>) =>
      fetch(`${baseUrl}/videos_x/_search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query }),
      });
    const failureOf = async (response: Response) => ({
      status: response.status,
      error: ((await response.json()) as { error?: unknown }).error,
    });

    // A shape the fake ignored used to match every document, and a term on the
    // analysed title compared the raw text, so a test could read an answer no
    // cluster gives and still pass
    expect(await failureOf(await searchFor({ terms: { videoPath: ['shape.mp4'] } }))).toEqual({
      status: 500,
      error: expect.stringContaining('the terms query is not modelled'),
    });
    expect(await failureOf(await searchFor({ bool: { must_not: [{ match_all: {} }] } }))).toEqual({
      status: 500,
      error: expect.stringContaining('bool.must_not is not modelled'),
    });
    expect(await failureOf(await searchFor({ term: { title: 'ksztaltdokument' } }))).toEqual({
      status: 500,
      error: expect.stringContaining('a term query on the text field title is not modelled'),
    });

    // The delete variant is the one that cost data: a clause the fake ignored
    // matched every document, so the whole index went
    const deleted = await fetch(`${baseUrl}/videos_x/_delete_by_query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: { match: { title: 'ksztaltdokument' } } }),
    });
    expect(await failureOf(deleted)).toEqual({
      status: 500,
      error: expect.stringContaining('the match query is not modelled'),
    });
    expect(await matchesFor('ksztaltdokument', 'title')).toBe(1);
  });

  it('holds a matching request until it is released, and serves the others meanwhile', async () => {
    const hold = fake.holdRequestsMatching('/_bulk');
    try {
      let answered = false;
      const held = bulk([{ index: { _index: 'videos_x', _id: 'held' } }, { title: 'Held' }]).then((response) => {
        answered = true;
        return response;
      });
      await hold.reached;

      expect((await search()).status).toBe(200);
      expect(answered).toBe(false);

      hold.release();
      expect((await held).status).toBe(200);
      // Released for good: the next bulk write goes straight through
      expect((await bulk([{ index: { _index: 'videos_x', _id: 'after' } }, { title: 'After' }])).status).toBe(200);
    } finally {
      // The fake is shared by the whole file: a held bulk must not outlive a failure
      hold.release();
    }
  });

  it('answers every held request when it stops, so a failed test cannot hang its teardown', async () => {
    const own = new FakeElasticsearch();
    const ownUrl = await own.start();
    const hold = own.holdRequestsMatching('/_cluster/health');
    let answered = false;
    const held = fetch(`${ownUrl}/_cluster/health`).then((response) => {
      answered = true;
      return response;
    });
    await hold.reached;

    const stopping = own.stop();
    await vi.waitFor(() => expect(answered, 'stop() answers the held request').toBe(true));
    await stopping;

    expect((await held).status).toBe(200);
  });

  it('starts every test from an empty fixture index', async () => {
    // Declared last, so in file order, the order PR CI runs, every test that
    // writes into the fixture index has run before this one reads it
    const total = ((await (await search()).json()) as { hits: { total: { value: number } } }).hits.total.value;

    expect(total).toBe(0);
  });
});
