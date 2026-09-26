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
      // The mapping the range rule reads; a real index maps the counts as
      // integer, so a value outside int32 is refused per item.
      body: JSON.stringify({
        settings: {},
        mappings: { properties: { title: { type: 'text' }, viewCount: { type: 'integer' } } },
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
});
