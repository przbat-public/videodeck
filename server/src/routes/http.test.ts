import express from 'express';
import request from 'supertest';
import { createAuthMiddleware, isAllowedCorsOrigin } from './http';
import { createApp } from '../app';

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
    const response = await request(buildApp('secret'))
      .get('/test')
      .set('Authorization', 'Bearer wrong');
    expect(response.status).toBe(401);
  });

  it('rejects non-bearer auth schemes', async () => {
    const response = await request(buildApp('secret'))
      .get('/test')
      .set('Authorization', 'Basic secret');
    expect(response.status).toBe(401);
  });

  it('accepts the configured bearer token', async () => {
    const response = await request(buildApp('secret'))
      .get('/test')
      .set('Authorization', 'Bearer secret');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
  });
});

describe('createApp auth wiring', () => {
  it('guards /api when a token is configured and keeps /health public', async () => {
    const app = createApp({ apiToken: 'integration-token' });

    const guarded = await request(app).get('/api/status');
    expect(guarded.status).toBe(401);

    const allowed = await request(app)
      .get('/api/status')
      .set('Authorization', 'Bearer integration-token');
    expect(allowed.status).not.toBe(401);

    const health = await request(app).get('/health');
    expect(health.status).toBe(200);
    expect(health.body).toEqual({ status: 'ok' });
  });

  it('leaves /api open without a configured token', async () => {
    const response = await request(createApp()).get('/api/status');
    expect(response.status).not.toBe(401);
  });
});

describe('isAllowedCorsOrigin', () => {
  it('allows the local dev client on any port', () => {
    expect(isAllowedCorsOrigin('http://localhost:3000')).toBe(true);
    expect(isAllowedCorsOrigin('http://127.0.0.1:4173')).toBe(true);
    expect(isAllowedCorsOrigin('https://localhost:8443')).toBe(true);
  });

  it('allows Chrome extensions', () => {
    expect(isAllowedCorsOrigin('chrome-extension://abcdefghijklmnop')).toBe(true);
  });

  it('allows explicitly configured extra origins', () => {
    expect(isAllowedCorsOrigin('https://videos.example.com', ['https://videos.example.com'])).toBe(
      true
    );
  });

  it('rejects everything else', () => {
    expect(isAllowedCorsOrigin('https://evil.example.com')).toBe(false);
    expect(isAllowedCorsOrigin('http://localhost.evil.com')).toBe(false);
    expect(isAllowedCorsOrigin('http://example.com:3000')).toBe(false);
  });
});
