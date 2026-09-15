import { defineConfig } from '@playwright/test';

/**
 * E2E tests run the real client (Vite dev server) against mocked API routes —
 * no Elasticsearch or backend needed. The tests intercept every /api call
 * with page.route and assert the actual UI flows: URL-driven search, load
 * more, the detail page with the player and the status page.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  // Flaky-once retries only on CI — locally a failure must be reproducible
  retries: process.env.CI ? 2 : 0,
  reporter: [['list']],
  // CI: one worker at a time keeps the e2e run deterministic
  workers: process.env.CI ? 1 : undefined,
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev -- --port 3000 --strictPort',
    port: 3000,
    // Never attach to a stray :3000 server on CI runners
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
