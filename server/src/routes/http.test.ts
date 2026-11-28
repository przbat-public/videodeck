import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib, { type Gunzip, gzipSync } from 'node:zlib';
import type { HealthResponse } from '@videodeck/shared/api';
import { HealthResponseSchema } from '@videodeck/shared/schemas';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import type { Test } from 'supertest';
import request from 'supertest';
import type { MockedFunction } from 'vitest';
import { createApp } from '../app';
import { metricsRegistry } from '../metricsRegistry';
import {
  checkElasticsearchConnection,
  checkElasticsearchWrites,
  getVideoByFilePath,
} from '../services/elasticsearchService';
import { type Authorizer, createAuthMiddleware, createAuthorizer, isAllowedCorsOrigin } from './http';

vi.mock('../services/elasticsearchService', () => ({
  checkElasticsearchConnection: vi.fn(),
  checkElasticsearchWrites: vi.fn(),
  getVideoByFilePath: vi.fn(),
}));

const mockedCheckElasticsearch = checkElasticsearchConnection as MockedFunction<typeof checkElasticsearchConnection>;
const mockedCheckWrites = checkElasticsearchWrites as MockedFunction<typeof checkElasticsearchWrites>;

// config.ts validates VIDEOS_FOLDER_PATH at import time
process.env.VIDEOS_FOLDER_PATH = '/test/videos';

/** Folders a test made its library, removed once it ends */
const tempLibraries: string[] = [];

/**
 * A library of one real folder holding the named files, set as
 * VIDEOS_FOLDER_PATH for the rest of the test. The file route reads the disk,
 * so a test of what it answers needs files that exist.
 */
function useTempLibrary(...fileNames: string[]): string {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'http-test-library-'));
  for (const name of fileNames) {
    fs.writeFileSync(path.join(folder, name), `bytes of ${name}`);
  }
  tempLibraries.push(folder);
  process.env.VIDEOS_FOLDER_PATH = folder;
  return folder;
}

afterEach(() => {
  process.env.VIDEOS_FOLDER_PATH = '/test/videos';
  for (const folder of tempLibraries.splice(0)) {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

/** The 200 answers to /health/live that http_requests_total has counted so far */
async function countedLivenessProbes(): Promise<number> {
  const counter = metricsRegistry.getSingleMetric('http_requests_total');
  const samples = (await counter?.get())?.values ?? [];
  return samples
    .filter((sample) => sample.labels.route === '/health/live' && String(sample.labels.status) === '200')
    .reduce((sum, sample) => sum + sample.value, 0);
}

describe('createAuthMiddleware', () => {
  /**
   * The guard in a bare app, the way createApp mounts it. Like that app, it
   * sits behind a rate limit, which CodeQL asks of every app that authorizes;
   * this one never counts close to its limit.
   */
  function guardedApp(authorize: Authorizer): express.Express {
    const app = express();
    app.use(rateLimit({ windowMs: 60_000, limit: 10_000 }));
    app.use(createAuthMiddleware(authorize));
    app.get('/test', (_req, res) => {
      res.json({ ok: true });
    });
    app.post('/test', (_req, res) => {
      res.json({ ok: true });
    });
    return app;
  }

  function buildApp(token?: string): express.Express {
    return guardedApp(createAuthorizer(token));
  }

  it('lets requests through when no token is configured', async () => {
    const response = await request(buildApp()).get('/test');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
  });

  it('refuses cross-site browser requests when no token is configured', async () => {
    const response = await request(buildApp()).get('/test').set('Sec-Fetch-Site', 'cross-site');
    expect(response.status).toBe(403);
  });

  it('refuses cross-site browser requests even with a valid token', async () => {
    // nginx injects the token for the proxied UI, so "has a token" says
    // nothing about who sent the request: a page on another origin would
    // otherwise drive the API as the token owner.
    const response = await request(buildApp('secret'))
      .get('/test')
      .set('Authorization', 'Bearer secret')
      .set('Sec-Fetch-Site', 'cross-site');
    expect(response.status).toBe(403);
  });

  it('refuses a same-site request from an origin that is not trusted', async () => {
    // Another port on this host is same-site, not cross-site. Only the known
    // client origins and CORS_ORIGINS may drive the API.
    const response = await request(buildApp())
      .get('/test')
      .set('Sec-Fetch-Site', 'same-site')
      .set('Origin', 'http://localhost:4000');
    expect(response.status).toBe(403);
  });

  it('accepts same-origin and trusted same-site browser requests', async () => {
    const sameOrigin = await request(buildApp()).get('/test').set('Sec-Fetch-Site', 'same-origin');
    expect(sameOrigin.status).toBe(200);

    const devClient = await request(buildApp())
      .get('/test')
      .set('Sec-Fetch-Site', 'same-site')
      .set('Origin', 'http://localhost:5173');
    expect(devClient.status).toBe(200);

    const extension = await request(buildApp())
      .get('/test')
      .set('Sec-Fetch-Site', 'same-site')
      .set('Origin', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop');
    expect(extension.status).toBe(200);
  });

  it('accepts a CORS_ORIGINS entry as same-site', async () => {
    const app = guardedApp(createAuthorizer(undefined, false, { extraOrigins: ['https://deck.example'] }));

    // Listed or not, a request the browser marks cross-site stays refused:
    // the Origin is read only after that verdict
    expect(
      (await request(app).get('/test').set('Sec-Fetch-Site', 'cross-site').set('Origin', 'https://deck.example'))
        .status,
    ).toBe(403);
    expect(
      (await request(app).get('/test').set('Sec-Fetch-Site', 'same-site').set('Origin', 'https://deck.example')).status,
    ).toBe(200);
  });

  // Browsers send no Sec-Fetch-Site to a plain-HTTP address that is not
  // loopback, which is how a LAN deploy is reached, so there the Origin decides
  const UNMARKED_REFUSAL = {
    error: 'Forbidden',
    message:
      'Requests from another origin are not allowed. List its host in ALLOWED_HOSTS or the origin in CORS_ORIGINS.',
  };

  it('refuses a POST from a foreign origin when the browser sends no Sec-Fetch-Site, token or not', async () => {
    const withToken = await request(buildApp('secret'))
      .post('/test')
      .set('Authorization', 'Bearer secret')
      .set('Origin', 'http://evil.example');
    const open = await request(buildApp()).post('/test').set('Origin', 'http://evil.example');

    expect(withToken.status).toBe(403);
    expect(withToken.body).toEqual(UNMARKED_REFUSAL);
    expect(open.status).toBe(403);
  });

  it('refuses an opaque or unparsable Origin when the browser sends no Sec-Fetch-Site', async () => {
    for (const origin of ['null', 'garbage']) {
      const response = await request(buildApp('secret'))
        .post('/test')
        .set('Authorization', 'Bearer secret')
        .set('Origin', origin);
      expect(response.status).toBe(403);
    }
  });

  it('refuses an unmarked GET from a foreign origin too, since some reads still write', async () => {
    const response = await request(buildApp('secret'))
      .get('/test')
      .set('Authorization', 'Bearer secret')
      .set('Origin', 'http://evil.example');
    expect(response.status).toBe(403);
  });

  it('refuses an unmarked extension whose id EXTENSION_ORIGINS does not list', async () => {
    const app = guardedApp(createAuthorizer('secret', false, { extensionOrigins: ['chrome-extension://otherid'] }));
    const response = await request(app)
      .post('/test')
      .set('Authorization', 'Bearer secret')
      .set('Origin', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop');
    // The refusal names the setting that lets this extension in, not the
    // ALLOWED_HOSTS and CORS_ORIGINS of the message for other pages
    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      error: 'Forbidden',
      message: 'Requests from this extension are not allowed. List its origin in EXTENSION_ORIGINS.',
    });
  });

  it('names CORS_ORIGINS alone when it refuses a loopback page', async () => {
    // A loopback Origin is a page on the browser's own machine, which no
    // ALLOWED_HOSTS entry lets in
    const app = guardedApp(createAuthorizer('secret', false, { allowedHosts: ['nas.local'] }));
    const response = await request(app)
      .post('/test')
      .set('Authorization', 'Bearer secret')
      .set('Host', 'nas.local')
      .set('Origin', 'http://localhost:9999');
    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      error: 'Forbidden',
      message: 'Requests from a loopback page are not allowed. List its origin in CORS_ORIGINS.',
    });
  });

  it('refuses a rebinding name that arrives as X-Forwarded-Host', async () => {
    // A proxy that rewrites Host to loopback hides the browser's host from the
    // Host guard, and a DNS-rebinding page sends its own name as the Origin
    // and, through the proxy, as X-Forwarded-Host. The forwarded name counts
    // only when the Host guard would accept it.
    for (const allowedHosts of [[], ['nas.local']]) {
      const response = await request(guardedApp(createAuthorizer('secret', false, { allowedHosts })))
        .post('/test')
        .set('Authorization', 'Bearer secret')
        .set('Host', '127.0.0.1:3001')
        .set('X-Forwarded-Host', 'evil.example:3000')
        .set('Origin', 'http://evil.example:3000');
      expect(response.status, allowedHosts.join(',')).toBe(403);
    }
  });

  it('never compares the Origin with Host once the forwarded name is untrusted', async () => {
    // Behind a proxy that sets Host to its own upstream, that Host is the
    // proxy's address, and a loopback Origin there is a page on the visitor's
    // machine. Falling back to Host let such a page post through an alias
    // of the proxy that ALLOWED_HOSTS does not list.
    for (const allowedHosts of [[], ['nas.local']]) {
      const response = await request(guardedApp(createAuthorizer('secret', false, { allowedHosts })))
        .post('/test')
        .set('Authorization', 'Bearer secret')
        .set('Host', '127.0.0.1:3001')
        .set('X-Forwarded-Host', '192.168.0.10:8080')
        .set('Origin', 'http://127.0.0.1:3001');
      expect(response.status, allowedHosts.join(',')).toBe(403);
    }
  });

  it('reads a rooted name, trailing dot and all, as the name it roots', async () => {
    // nginx drops the dot from $host but not from $http_host: the Host guard
    // sees nas.local, while X-Forwarded-Host and the Origin keep the dot
    const app = guardedApp(createAuthorizer('secret', false, { allowedHosts: ['nas.local'] }));
    const response = await request(app)
      .post('/test')
      .set('Authorization', 'Bearer secret')
      .set('Host', 'nas.local')
      .set('X-Forwarded-Host', 'nas.local.:3000')
      .set('Origin', 'http://nas.local.:3000');
    expect(response.status).toBe(200);
  });

  it('keeps loopback names out of the ALLOWED_HOSTS rule', async () => {
    // In an Origin, localhost is a page on the browser's own machine
    const app = guardedApp(createAuthorizer('secret', false, { allowedHosts: ['localhost', 'nas.local'] }));
    const response = await request(app)
      .post('/test')
      .set('Host', 'nas.local')
      .set('X-Forwarded-Host', 'nas.local:3000')
      .set('Authorization', 'Bearer secret')
      .set('Origin', 'http://localhost:9999');
    expect(response.status).toBe(403);
  });

  it('accepts an unmarked POST whose Origin is the address the browser used', async () => {
    // Behind nginx the address comes as X-Forwarded-Host (its first value,
    // port included), without a proxy it is the Host itself. Loopback is the
    // case only this rule covers: the ALLOWED_HOSTS rule leaves it out.
    const post = (headers: Record<string, string>) =>
      request(buildApp('secret')).post('/test').set('Authorization', 'Bearer secret').set(headers);

    expect(
      (await post({ Host: '127.0.0.1', 'X-Forwarded-Host': '127.0.0.1:8092', Origin: 'http://127.0.0.1:8092' })).status,
    ).toBe(200);
    expect(
      (
        await post({
          Host: '127.0.0.1',
          'X-Forwarded-Host': '127.0.0.1:8092, inner',
          Origin: 'http://127.0.0.1:8092',
        })
      ).status,
    ).toBe(200);
    expect((await post({ Host: 'localhost:8080', Origin: 'http://localhost:8080' })).status).toBe(200);
    // An IPv6 literal keeps its brackets in both headers
    expect((await post({ Host: '[::1]', 'X-Forwarded-Host': '[::1]:8092', Origin: 'http://[::1]:8092' })).status).toBe(
      200,
    );
  });

  it('accepts an unmarked POST from an ALLOWED_HOSTS host on any port, IPv6 included', async () => {
    const app = guardedApp(createAuthorizer('secret', false, { allowedHosts: ['nas.local', 'fd00::1'] }));
    const post = (host: string, origin: string) =>
      request(app).post('/test').set('Authorization', 'Bearer secret').set('Host', host).set('Origin', origin);

    expect((await post('nas.local', 'http://nas.local:3000')).status).toBe(200);
    expect((await post('[fd00::1]', 'http://[fd00::1]:3000')).status).toBe(200);
  });

  it('lets an unmarked request without an Origin on to the token check', async () => {
    // curl and the server itself send no Origin at all
    expect((await request(buildApp('secret')).post('/test').set('Authorization', 'Bearer secret')).status).toBe(200);
    const curl = await request(buildApp('secret')).post('/test');
    expect(curl.status).toBe(401);
    expect(curl.body).toEqual({ error: 'Unauthorized', message: 'Missing or invalid API token' });
  });

  it('accepts an unmarked POST from a trusted origin', async () => {
    // The extension worker posts from its own origin to a LAN server
    const app = guardedApp(createAuthorizer('secret', false, { extraOrigins: ['http://media.lan:8080'] }));
    for (const origin of [
      'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
      'http://localhost:5173',
      'http://media.lan:8080',
    ]) {
      const response = await request(app)
        .post('/test')
        .set('Host', 'nas.local:3001')
        .set('Authorization', 'Bearer secret')
        .set('Origin', origin);
      expect(response.status).toBe(200);
    }
  });

  it('rejects requests without an Authorization header', async () => {
    const response = await request(buildApp('secret')).get('/test');
    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      error: 'Unauthorized',
      message: 'Missing or invalid API token',
    });
  });

  it('rejects a wrong bearer token', async () => {
    const response = await request(buildApp('secret')).get('/test').set('Authorization', 'Bearer wrong');
    expect(response.status).toBe(401);
  });

  it('rejects non-bearer auth schemes', async () => {
    const response = await request(buildApp('secret')).get('/test').set('Authorization', 'Basic secret');
    expect(response.status).toBe(401);
  });

  it('accepts the configured bearer token', async () => {
    const response = await request(buildApp('secret')).get('/test').set('Authorization', 'Bearer secret');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
  });
});

describe('createApp auth wiring', () => {
  /** Minimal DownloadQueue stand-in so /api routes answer without Elasticsearch */
  const fakeQueue = () => ({
    enqueue: vi.fn(),
    list: vi.fn(() => []),
    summary: vi.fn(() => ({
      counts: { queued: 0, running: 0, done: 0, error: 0, cancelled: 0 },
      folders: {},
      running: [],
    })),
    get: vi.fn(),
    cancel: vi.fn(),
    cancelAll: vi.fn(() => 0),
    whenPersisted: vi.fn(() => Promise.resolve()),
    setPaused: vi.fn(),
    isPaused: vi.fn(() => false),
    clearFinished: vi.fn(() => 0),
    on: vi.fn(),
    off: vi.fn(),
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockedCheckElasticsearch.mockResolvedValue(true);
    mockedCheckWrites.mockResolvedValue('accepted');
  });

  it('guards /api when a token is configured and keeps /health public', async () => {
    const app = createApp({ apiToken: 'integration-token' });

    const guarded = await request(app).get('/api/status');
    expect(guarded.status).toBe(401);

    const allowed = await request(app).get('/api/status').set('Authorization', 'Bearer integration-token');
    expect(allowed.status).not.toBe(401);

    const health = await request(app).get('/health');
    expect(health.status).toBe(200);
    expect(health.body).toEqual({ status: 'ok', elasticsearch: 'ok', revision: expect.any(Number) });
  });

  it('refuses a form POST from a foreign page on an ALLOWED_HOSTS host, with the token the proxy adds', async () => {
    const originalAllowedHosts = process.env.ALLOWED_HOSTS;
    process.env.ALLOWED_HOSTS = 'nas.local';
    try {
      const queue = fakeQueue();
      const app = createApp({ apiToken: 'lan-token', downloadQueue: queue });
      // A form a foreign page submits: no preflight, no marker on plain HTTP
      const pause = (origin: string) =>
        request(app)
          .post('/api/folder/queue/pause?paused=1')
          .set('Host', 'nas.local')
          .set('Authorization', 'Bearer lan-token')
          .set('Origin', origin)
          .type('form')
          .send('');

      const forged = await pause('http://evil.example');
      expect(forged.status).toBe(403);
      expect(queue.setPaused).not.toHaveBeenCalled();

      // The UI's own page on that host passes, on its own port
      const ui = await pause('http://nas.local:3000');
      expect(ui.status).toBe(200);
      expect(queue.setPaused).toHaveBeenCalledTimes(1);
      expect(queue.setPaused).toHaveBeenCalledWith(true);
    } finally {
      if (originalAllowedHosts === undefined) {
        delete process.env.ALLOWED_HOSTS;
      } else {
        process.env.ALLOWED_HOSTS = originalAllowedHosts;
      }
    }
  });

  it('leaves /api open without a configured token', async () => {
    const response = await request(createApp()).get('/api/status');
    expect(response.status).not.toBe(401);
  });

  it('treats a blank token option as no token rather than as a configured one', async () => {
    // index.ts asks getApiToken() before it passes anything, and this is the
    // other half of that agreement: a whitespace token must not turn /api into
    // "guarded by a token nobody can send".
    const response = await request(createApp({ apiToken: '   ' })).get('/api/status');
    expect(response.status).not.toBe(401);
  });

  it('reports a degraded health when Elasticsearch is down', async () => {
    mockedCheckElasticsearch.mockResolvedValue(false);

    const health = await request(createApp()).get('/health');

    expect(health.status).toBe(503);
    expect(health.body).toEqual({ status: 'degraded', elasticsearch: 'down', revision: expect.any(Number) });
    // There is no cluster to ask for its blocks
    expect(mockedCheckWrites).not.toHaveBeenCalled();
  });

  it('reports refused writes with a 200 while the cluster still answers', async () => {
    // A read-only index serves search and refuses every write. A 503 would
    // raise the outage banner over a search that works.
    mockedCheckWrites.mockResolvedValue('refused');

    const health = await request(createApp()).get('/api/health');

    expect(health.status).toBe(200);
    expect(health.body).toEqual({
      status: 'ok',
      elasticsearch: 'ok',
      revision: expect.any(Number),
      writes: 'refused',
    });
    expect(HealthResponseSchema.parse(health.body)).toEqual(health.body);
  });

  it('claims nothing about writes when the cluster does not say', async () => {
    // A role that grants the ping (cluster:monitor/main) and not
    // cluster:monitor/state cannot read the blocks. Without monitor, which
    // grants both, the ping fails first and the cluster reads as down.
    mockedCheckWrites.mockResolvedValue('unknown');

    const health = await request(createApp()).get('/health');

    expect(health.status).toBe(200);
    expect(health.body).toEqual({ status: 'ok', elasticsearch: 'ok', revision: expect.any(Number) });
  });

  it('probes again while writes are refused, so their return shows at once', async () => {
    // Like an outage, a refusal is not cached: the banner's retry would
    // otherwise show it for the whole TTL after the disk was freed
    mockedCheckWrites.mockResolvedValueOnce('refused').mockResolvedValueOnce('accepted');
    const app = createApp();

    expect((await request(app).get('/health')).body).toMatchObject({ writes: 'refused' });
    expect((await request(app).get('/health')).body).not.toHaveProperty('writes');
    expect(mockedCheckElasticsearch).toHaveBeenCalledTimes(2);
  });

  it('reports the library revision and moves it when the library changes', async () => {
    const original = process.env.VIDEOS_FOLDER_PATH;
    try {
      process.env.VIDEOS_FOLDER_PATH = '/test/videos';
      const app = createApp();

      const first = await request(app).get('/api/health');
      const firstBody = first.body as HealthResponse;
      expect(firstBody.status).toBe('ok');
      expect(Number.isInteger(firstBody.revision)).toBe(true);
      expect(firstBody.revision).toBeGreaterThan(0);

      // The same library answers the same revision: the number belongs to the
      // library, not to the 5 s Elasticsearch cache the probe keeps
      const again = await request(app).get('/api/health');
      expect((again.body as HealthResponse).revision).toBe(firstBody.revision);

      process.env.VIDEOS_FOLDER_PATH = '/test/videos/extra';
      const moved = await request(app).get('/api/health');
      expect((moved.body as HealthResponse).revision).toBeGreaterThan(firstBody.revision);
    } finally {
      process.env.VIDEOS_FOLDER_PATH = original;
    }
  });

  it('exposes Prometheus metrics', async () => {
    const app = createApp();

    const response = await request(app).get('/metrics');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.text).toContain('http_requests_total');
    expect(response.text).toContain('http_request_duration_seconds');
    expect(response.text).toContain('download_queue_size');
  });

  it('answers JSON 404 for unknown paths instead of an HTML page', async () => {
    const response = await request(createApp()).get('/api/does-not-exist');

    expect(response.status).toBe(404);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.body).toEqual({ error: 'Not found' });
  });

  it('sets basic security headers on every response', async () => {
    const response = await request(createApp()).get('/health');

    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });

  it('answers /health/live without touching Elasticsearch', async () => {
    const app = createApp();

    const response = await request(app).get('/health/live');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
    expect(mockedCheckElasticsearch).not.toHaveBeenCalled();
  });

  it('serves the same health answer under /api for the browser client', async () => {
    mockedCheckElasticsearch.mockResolvedValue(false);
    const app = createApp();

    const response = await request(app).get('/api/health');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ status: 'degraded', elasticsearch: 'down', revision: expect.any(Number) });
    // The API namespace is the one the dev proxy and nginx forward
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('caches the Elasticsearch check across consecutive /health probes', async () => {
    mockedCheckElasticsearch.mockResolvedValue(true);
    const app = createApp();

    await request(app).get('/health');
    await request(app).get('/health');

    expect(mockedCheckElasticsearch).toHaveBeenCalledTimes(1);
    // The blocks are part of the cached answer, not one more call per probe
    expect(mockedCheckWrites).toHaveBeenCalledTimes(1);
  });

  it('stamps every response with an X-Request-Id', async () => {
    const response = await request(createApp()).get('/health');

    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('keeps query values out of the request log', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {
      /* captured by the assertions below */
    });
    const app = createApp({ downloadQueue: fakeQueue() });

    // A mounted route on purpose: while the router handles the request,
    // Express rewrites `req.url` to the path inside the mount, so reading it
    // in the finish handler logged "/folder/queue" with no "/api" prefix.
    const response = await request(app).get('/api/folder/queue?folderPath=/private/videos');

    // The path identifies the endpoint; the query would put a folder path or
    // a search phrase into a log that outlives the request.
    expect(response.status).toBe(200);
    const line = String(log.mock.calls.at(-1)?.[0] ?? '');
    expect(line).toContain('GET /api/folder/queue');
    expect(line).not.toContain('/private/videos');

    log.mockRestore();
  });

  it('keeps liveness probes out of the request log and still counts them', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {
      /* captured by the assertions below */
    });
    const app = createApp();
    const countedBefore = await countedLivenessProbes();

    const response = await request(app).get('/health/live');

    // The server image's healthcheck asks this path every 30 s: a line per
    // probe buried the requests an operator reads the log for
    expect(response.status).toBe(200);
    const lines = log.mock.calls.map((call) => String(call[0]));
    expect(lines.filter((line) => line.includes('/health/live'))).toEqual([]);
    // A stalled event loop still shows up on /metrics
    expect(await countedLivenessProbes()).toBe(countedBefore + 1);

    log.mockRestore();
  });

  it('answers API requests with a fresh body instead of a 304', async () => {
    const app = createApp({ downloadQueue: fakeQueue() });

    const first = await request(app).get('/api/folder/queue');

    // No ETag to revalidate: Express answered the browser's conditional polls
    // with "304 Not Modified" and an empty body, and fetch reports that as
    // `ok: false`, so the queue controls showed a load error during polling.
    expect(first.headers.etag).toBeUndefined();
    expect(first.headers['cache-control']).toBe('no-store');

    const conditional = await request(app)
      .get('/api/folder/queue')
      .set('If-None-Match', 'W/"1a-r58vDHgamo0RCXYOQAGwXQFm9YU"');

    expect(conditional.status).toBe(200);
    expect(conditional.body).toEqual(first.body);
  });

  it('accepts an injected download queue', async () => {
    const queue = fakeQueue();
    const app = createApp({ downloadQueue: queue });

    const response = await request(app).get('/api/folder/queue').query({ folderPath: '/test/videos' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ jobs: [], total: 0, paused: false });
    expect(queue.list).toHaveBeenCalledWith('/test/videos');
  });
});

describe('isAllowedCorsOrigin', () => {
  it('allows the local dev client on the known dev ports only', () => {
    expect(isAllowedCorsOrigin('http://localhost:3000')).toBe(true);
    expect(isAllowedCorsOrigin('http://127.0.0.1:4173')).toBe(true);
    expect(isAllowedCorsOrigin('http://localhost:5173')).toBe(true);
    // Any other localhost port is NOT trusted by default (a page served from
    // an arbitrary local server would be same-site and could drive the API);
    // extra origins go through CORS_ORIGINS.
    expect(isAllowedCorsOrigin('https://localhost:8443')).toBe(false);
    expect(isAllowedCorsOrigin('http://localhost:9999')).toBe(false);
    expect(isAllowedCorsOrigin('http://localhost:3000', ['https://localhost:8443'])).toBe(true);
    expect(isAllowedCorsOrigin('https://localhost:8443', ['https://localhost:8443'])).toBe(true);
  });

  it('allows Chrome extensions', () => {
    expect(isAllowedCorsOrigin('chrome-extension://abcdefghijklmnop')).toBe(true);
  });

  it('keeps extension origins open without a configured list', () => {
    expect(isAllowedCorsOrigin('chrome-extension://abcdefghijklmnop', [], undefined)).toBe(true);
  });

  it('restricts extension origins to the configured list', () => {
    expect(isAllowedCorsOrigin('chrome-extension://abcdefghijklmnop', [], ['chrome-extension://otherid'])).toBe(false);
    expect(
      isAllowedCorsOrigin('chrome-extension://abcdefghijklmnop', [], ['chrome-extension://abcdefghijklmnop']),
    ).toBe(true);
  });

  it('allows explicitly configured extra origins', () => {
    expect(isAllowedCorsOrigin('https://videos.example.com', ['https://videos.example.com'])).toBe(true);
  });

  it('rejects everything else', () => {
    expect(isAllowedCorsOrigin('https://evil.example.com')).toBe(false);
    expect(isAllowedCorsOrigin('http://localhost.evil.com')).toBe(false);
    expect(isAllowedCorsOrigin('http://example.com:3000')).toBe(false);
  });
});

describe('Host header guard (DNS rebinding)', () => {
  const originalAllowedHosts = process.env.ALLOWED_HOSTS;

  beforeEach(() => {
    // These tests build their own app and assert 200 on /health, which answers
    // 503 while the probe reports the cluster down. The mock's implementation
    // lives for the whole file, so without this pin a test above that set it to
    // false decides these answers instead of the Host header under test.
    mockedCheckElasticsearch.mockResolvedValue(true);
  });

  afterEach(() => {
    if (originalAllowedHosts === undefined) {
      delete process.env.ALLOWED_HOSTS;
    } else {
      process.env.ALLOWED_HOSTS = originalAllowedHosts;
    }
  });

  it('accepts loopback Host headers with any port', async () => {
    const app = createApp();
    for (const host of ['127.0.0.1', '127.0.0.1:3000', 'localhost', 'localhost:5173', '[::1]', '[::1]:8080']) {
      const response = await request(app).get('/health').set('Host', host);
      expect(response.status).toBe(200);
    }
  });

  it('rejects an unknown Host header', async () => {
    const response = await request(createApp()).get('/health').set('Host', 'evil.example.com');

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'Forbidden', message: 'Unknown Host header' });
  });

  it('accepts hosts listed in ALLOWED_HOSTS', async () => {
    process.env.ALLOWED_HOSTS = 'nas.local, 192.168.0.10';
    const app = createApp();

    const byName = await request(app).get('/health').set('Host', 'nas.local:4567');
    expect(byName.status).toBe(200);

    const byIp = await request(app).get('/health').set('Host', '192.168.0.10');
    expect(byIp.status).toBe(200);
  });
});

describe('file responses', () => {
  // The real sendFile on real files: the unit suite's stand-in for it cannot
  // show which Content-Type and Cache-Control reach the browser
  it.each([
    ['a.webp', 'image/webp'],
    ['b.jpg', 'image/jpeg'],
    ['c.jpeg', 'image/jpeg'],
    ['d.png', 'image/png'],
  ])('serves a %s thumbnail as %s with the thumbnail cache policy', async (name, contentType) => {
    const folder = useTempLibrary(name);

    const response = await request(createApp()).get(`/api/videos/file/${name}`).query({ folder });

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe(contentType);
    expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it.each(['e.info.json', 'e.description', 'e.en.srt'])(
    'serves %s, which an update rewrites in place, under the no-store of the API',
    async (name) => {
      const folder = useTempLibrary(name);

      const response = await request(createApp()).get(`/api/videos/file/${name}`).query({ folder });

      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
    },
  );
});

describe('rate limiting', () => {
  const originalMax = process.env.RATE_LIMIT_MAX;
  const originalWindow = process.env.RATE_LIMIT_WINDOW_MS;
  const originalRequireToken = process.env.REQUIRE_API_TOKEN;

  afterEach(() => {
    if (originalMax === undefined) {
      delete process.env.RATE_LIMIT_MAX;
    } else {
      process.env.RATE_LIMIT_MAX = originalMax;
    }
    if (originalWindow === undefined) {
      delete process.env.RATE_LIMIT_WINDOW_MS;
    } else {
      process.env.RATE_LIMIT_WINDOW_MS = originalWindow;
    }
    if (originalRequireToken === undefined) {
      delete process.env.REQUIRE_API_TOKEN;
    } else {
      process.env.REQUIRE_API_TOKEN = originalRequireToken;
    }
  });

  it('rejects a burst beyond the configured limit', async () => {
    process.env.RATE_LIMIT_MAX = '3';
    process.env.RATE_LIMIT_WINDOW_MS = '60000';
    const app = createApp();

    for (let i = 0; i < 3; i += 1) {
      expect((await request(app).get('/health/live')).status).toBe(200);
    }

    const limited = await request(app).get('/health/live');
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ error: 'Too many requests' });
  });

  it('lets media reads through without spending the API budget', async () => {
    process.env.RATE_LIMIT_MAX = '3';
    process.env.RATE_LIMIT_WINDOW_MS = '60000';
    const folder = useTempLibrary('a.webp');
    const app = createApp();

    // A results page asks for one thumbnail per card and the player for range
    // after range of one video, so a budget sized for the API ran out mid-page
    for (let i = 0; i < 5; i += 1) {
      expect((await request(app).get('/api/videos/file/a.webp').query({ folder })).status).toBe(200);
    }

    // The budget is still whole, and the same query on another path buys
    // nothing: only the file route is exempt
    for (let i = 0; i < 3; i += 1) {
      expect((await request(app).get('/api/videos/refreshCache/status').query({ folder })).status).toBe(200);
    }
    const limited = await request(app).get('/api/videos/refreshCache/status').query({ folder });
    expect(limited.status).toBe(429);
  });

  it('lets media reads with the right token through without spending the API budget', async () => {
    process.env.RATE_LIMIT_MAX = '3';
    process.env.RATE_LIMIT_WINDOW_MS = '60000';
    const folder = useTempLibrary('a.webp');
    const app = createApp({ apiToken: 'media-token' });

    // Five reads on a budget of three: the auth lets each one through, so
    // none of them counts
    for (let i = 0; i < 5; i += 1) {
      const response = await request(app)
        .get('/api/videos/file/a.webp')
        .query({ folder })
        .set('Authorization', 'Bearer media-token');
      expect(response.status).toBe(200);
    }
  });

  it.each<[string, () => express.Express, Record<string, string>, number]>([
    ['a wrong token', () => createApp({ apiToken: 'media-token' }), { Authorization: 'Bearer guess' }, 401],
    ['a cross-site page', () => createApp(), { 'Sec-Fetch-Site': 'cross-site' }, 403],
    ['a foreign origin without the marker', () => createApp(), { Origin: 'http://evil.example' }, 403],
    [
      'an untrusted origin on this host',
      () => createApp(),
      { 'Sec-Fetch-Site': 'same-site', Origin: 'http://localhost:4000' },
      403,
    ],
    [
      'REQUIRE_API_TOKEN without a token',
      () => {
        process.env.REQUIRE_API_TOKEN = 'true';
        return createApp();
      },
      {},
      401,
    ],
  ])('still counts a media read that auth refuses: %s', async (_case, makeApp, headers, refusal) => {
    process.env.RATE_LIMIT_MAX = '3';
    process.env.RATE_LIMIT_WINDOW_MS = '60000';
    const folder = useTempLibrary('a.webp');
    const app = makeApp();
    const read = () => request(app).get('/api/videos/file/a.webp').query({ folder }).set(headers);

    // A refused read is a guess, at the token or at an origin the guard
    // trusts, and the budget is what bounds the guesses
    for (let i = 0; i < 3; i += 1) {
      expect((await read()).status).toBe(refusal);
    }
    expect((await read()).status).toBe(429);
  });

  it.each<[string, (read: Test) => Test]>([
    ['a JSON body', (read) => read.set('Content-Type', 'application/json').send('{}')],
    ['a Content-Type alone', (read) => read.set('Content-Type', 'application/json')],
    ['a body without a Content-Type', (read) => read.send(Buffer.from('{}'))],
    ['a chunked body', (read) => read.set('Transfer-Encoding', 'chunked')],
  ])('still counts a file read that carries %s', async (_case, withBody) => {
    process.env.RATE_LIMIT_MAX = '3';
    process.env.RATE_LIMIT_WINDOW_MS = '60000';
    const folder = useTempLibrary('a.webp');
    const app = createApp();
    const read = () => withBody(request(app).get('/api/videos/file/a.webp').query({ folder }));

    // An img or a video element never sends a body. A JSON-typed one goes
    // through the parser, whose failures reach the error log, so a GET that
    // declares any body pays like an API call
    for (let i = 0; i < 3; i += 1) {
      expect((await read()).status).toBe(200);
    }
    expect((await read()).status).toBe(429);
  });

  it('lets a media read that declares an empty body through', async () => {
    process.env.RATE_LIMIT_MAX = '3';
    process.env.RATE_LIMIT_WINDOW_MS = '60000';
    const folder = useTempLibrary('a.webp');
    const app = createApp();

    // Content-Length: 0 says there is no body, as a missing one does
    for (let i = 0; i < 5; i += 1) {
      const response = await request(app).get('/api/videos/file/a.webp').query({ folder }).set('Content-Length', '0');
      expect(response.status).toBe(200);
    }
  });

  it('still counts a file read that asks Elasticsearch for its folder', async () => {
    process.env.RATE_LIMIT_MAX = '3';
    process.env.RATE_LIMIT_WINDOW_MS = '60000';
    useTempLibrary('a.webp');
    vi.mocked(getVideoByFilePath).mockResolvedValue(null);
    const app = createApp();

    // The shipped clients always name the folder; a read without one costs a
    // lookup in the cluster, so it stays on the budget
    for (let i = 0; i < 3; i += 1) {
      expect((await request(app).get('/api/videos/file/a.webp')).status).toBe(404);
    }
    const limited = await request(app).get('/api/videos/file/a.webp');
    expect(limited.status).toBe(429);
  });

  it('still counts a file request that is not a GET', async () => {
    process.env.RATE_LIMIT_MAX = '3';
    process.env.RATE_LIMIT_WINDOW_MS = '60000';
    const folder = useTempLibrary('a.webp');
    const app = createApp();

    // Express answers a HEAD from the GET route, but no page sends one: an
    // image or a video element reads with GET
    for (let i = 0; i < 3; i += 1) {
      expect((await request(app).head('/api/videos/file/a.webp').query({ folder })).status).toBe(200);
    }
    const limited = await request(app).head('/api/videos/file/a.webp').query({ folder });
    expect(limited.status).toBe(429);
  });
});

describe('request body parsing', () => {
  /**
   * POST a gzip body, then bytes that arrive after the member already ended.
   * The zero byte is the precondition: Node's gunzip takes it as padding that
   * ends the decoded stream, so body-parser's read succeeds and the request
   * moves on while the trailing bytes are still on their way. Without it the
   * read itself fails and the answer is a plain 400.
   */
  function postGzipWithTrailingBytes(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/api/folder/queue',
          headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Transfer-Encoding': 'chunked' },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.write(Buffer.concat([gzipSync('{}'), Buffer.from([0])]));
      req.write('AAAA');
      req.end();
    });
  }

  /**
   * Settles once the gzip decoder body-parser created is done: closed, or
   * destroyed by an error that escaped. A decoder destroyed by an unhandled
   * error never emits 'close' (the throw cuts that short), so the escape is
   * the other way out. No error listener goes on the decoder: one (which
   * `events.once` would add) would handle the very error this test is about.
   */
  function decoderSettled(decoder: Gunzip, escaped: Promise<unknown>): Promise<void> {
    const closed = new Promise<void>((resolve) => {
      if (decoder.closed) {
        resolve();
      } else {
        decoder.once('close', () => resolve());
      }
    });
    return Promise.race([closed, escaped.then(() => undefined)]);
  }

  // body-parser 2.3.0 left the gunzip stream piped after a successful read,
  // with no error listener on it. The auth middleware still answered 401, and
  // right after that the trailing bytes reached the decoder and its unhandled
  // 'error' took the whole process down: express.json runs before auth, so
  // no token was needed (GHSA-27r3-jxmh-p828).
  it('survives bytes that trail a gzip body', async () => {
    let escapedError: unknown;
    let reportEscape: (error: unknown) => void = () => undefined;
    const escaped = new Promise<unknown>((resolve) => {
      reportEscape = resolve;
    });
    const onUncaught = (error: unknown): void => {
      escapedError = error;
      reportEscape(error);
    };
    process.on('uncaughtException', onUncaught);
    const createGunzip = vi.spyOn(zlib, 'createGunzip');
    const server = createApp({ apiToken: 'integration-token' }).listen(0, '127.0.0.1');
    try {
      await once(server, 'listening');
      const { port } = server.address() as AddressInfo;

      expect(await postGzipWithTrailingBytes(port)).toBe(401);
      expect(createGunzip).toHaveBeenCalledOnce();
      const decoder = createGunzip.mock.results[0]?.value as Gunzip;
      await decoderSettled(decoder, escaped);

      // A decoder destroyed by its own error reads as closed too, so the
      // verdict is the error it carries, not the closed flag
      expect(decoder.errored).toBeNull();
      expect(escapedError).toBeUndefined();
      expect((await request(server).get('/health/live')).status).toBe(200);
    } finally {
      createGunzip.mockRestore();
      process.off('uncaughtException', onUncaught);
      server.close();
    }
  });
});
