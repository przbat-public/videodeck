import express from 'express';
import request from 'supertest';
import { createApp } from '../app';
import { checkElasticsearchConnection } from '../services/elasticsearchService';
import { createAuthMiddleware, isAllowedCorsOrigin } from './http';

jest.mock('../services/elasticsearchService', () => ({
  checkElasticsearchConnection: jest.fn(),
}));

const mockedCheckElasticsearch = checkElasticsearchConnection as jest.MockedFunction<
  typeof checkElasticsearchConnection
>;

// config.ts validates VIDEOS_FOLDER_PATH at import time
process.env.VIDEOS_FOLDER_PATH = '/test/videos';

describe('createAuthMiddleware', () => {
  function buildApp(token?: string): express.Express {
    const app = express();
    app.use(createAuthMiddleware(token));
    app.get('/test', (_req, res) => {
      res.json({ ok: true });
    });
    return app;
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

  it('accepts same-origin and same-site browser requests when no token is configured', async () => {
    const sameOrigin = await request(buildApp()).get('/test').set('Sec-Fetch-Site', 'same-origin');
    expect(sameOrigin.status).toBe(200);

    const sameSite = await request(buildApp()).get('/test').set('Sec-Fetch-Site', 'same-site');
    expect(sameSite.status).toBe(200);
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
    enqueue: jest.fn(),
    list: jest.fn(() => []),
    get: jest.fn(),
    cancel: jest.fn(),
    cancelAll: jest.fn(() => 0),
    setPaused: jest.fn(),
    clearFinished: jest.fn(() => 0),
    on: jest.fn(),
    off: jest.fn(),
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockedCheckElasticsearch.mockResolvedValue(true);
  });

  it('guards /api when a token is configured and keeps /health public', async () => {
    const app = createApp({ apiToken: 'integration-token' });

    const guarded = await request(app).get('/api/status');
    expect(guarded.status).toBe(401);

    const allowed = await request(app).get('/api/status').set('Authorization', 'Bearer integration-token');
    expect(allowed.status).not.toBe(401);

    const health = await request(app).get('/health');
    expect(health.status).toBe(200);
    expect(health.body).toEqual({ status: 'ok', elasticsearch: 'ok' });
  });

  it('leaves /api open without a configured token', async () => {
    const response = await request(createApp()).get('/api/status');
    expect(response.status).not.toBe(401);
  });

  it('reports a degraded health when Elasticsearch is down', async () => {
    mockedCheckElasticsearch.mockResolvedValue(false);

    const health = await request(createApp()).get('/health');

    expect(health.status).toBe(503);
    expect(health.body).toEqual({ status: 'degraded', elasticsearch: 'down' });
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

  it('caches the Elasticsearch check across consecutive /health probes', async () => {
    mockedCheckElasticsearch.mockResolvedValue(true);
    const app = createApp();

    await request(app).get('/health');
    await request(app).get('/health');

    expect(mockedCheckElasticsearch).toHaveBeenCalledTimes(1);
  });

  it('stamps every response with an X-Request-Id', async () => {
    const response = await request(createApp()).get('/health');

    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('keeps query values out of the request log', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {
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
    expect(response.body).toEqual({ jobs: [], paused: false });
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

describe('rate limiting', () => {
  const originalMax = process.env.RATE_LIMIT_MAX;
  const originalWindow = process.env.RATE_LIMIT_WINDOW_MS;

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
});
