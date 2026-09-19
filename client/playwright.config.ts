import { defineConfig } from '@playwright/test';

/**
 * E2E tests run the real client (Vite dev server) against mocked API routes —
 * no Elasticsearch or backend needed. The tests intercept every /api call
 * with page.route and assert the actual UI flows: URL-driven search, load
 * more, the detail page with the player and the status page.
 *
 * `E2E_PORT` moves the run to another port. Local runs reuse whatever already
 * answers on 3000, which is convenient when it is this app and wrong when
 * another project's dev server squats the port: the suite then tests that
 * application instead. Set `E2E_PORT=3210 pnpm run test:e2e` to run beside it
 * instead. CI keeps the default.
 */
const port = Number(process.env.E2E_PORT ?? 3000);
const explicitPort = process.env.E2E_PORT !== undefined;

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  // Flaky-once retries only on CI — locally a failure must be reproducible
  retries: process.env.CI ? 2 : 0,
  reporter: [['list']],
  // CI: one worker at a time keeps the e2e run deterministic
  workers: process.env.CI ? 1 : undefined,
  use: {
    baseURL: `http://localhost:${port}`,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `npm run dev -- --port ${port} --strictPort`,
    port,
    // Never attach to a stray server on CI runners, and never attach to one
    // when E2E_PORT asked for a specific port: that request means "start here".
    reuseExistingServer: !process.env.CI && !explicitPort,
    timeout: 30_000,
  },
});
