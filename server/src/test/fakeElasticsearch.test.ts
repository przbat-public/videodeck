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
      body: JSON.stringify({ settings: {}, mappings: {} }),
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
});
