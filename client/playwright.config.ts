import { defineConfig } from '@playwright/test';

/**
 * E2E tests run the real client against mocked API routes; no Elasticsearch
 * or backend is needed. The tests intercept every /api call with page.route and
 * assert the actual UI flows: URL-driven search, load more, the detail page
 * with the player and the status page.
 *
 * `E2E_PORT` moves the run to another port. Local runs reuse whatever already
 * answers on 3000, which is convenient when it is this app and wrong when
 * another project's dev server squats the port: the suite then tests that
 * application instead. Set `E2E_PORT=3210 pnpm run test:e2e` to run beside it
 * instead. CI keeps the default.
 *
 * `E2E_TARGET=preview` runs the same suite against the production bundle
 * (`vite build` + `vite preview`, default port 4173) instead of the dev
 * server, so build-only failures (chunking, minification, base path) cannot
 * pass unnoticed. It needs a fresh `pnpm run build` first; CI has a separate
 * job for it. Plain `test:e2e` keeps the fast dev server.
 */
const target = process.env.E2E_TARGET ?? 'dev';
const isPreview = target === 'preview';
if (target !== 'dev' && !isPreview) {
  throw new Error(`E2E_TARGET must be "dev" or "preview", got "${target}"`);
}

const defaultPort = isPreview ? 4173 : 3000;
const port = Number(process.env.E2E_PORT ?? defaultPort);
const explicitPort = process.env.E2E_PORT !== undefined;

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  // Flaky-once retries only on CI; locally a failure must be reproducible
  retries: process.env.CI ? 2 : 0,
  // `list` keeps the console readable; the html report is the artifact CI
  // uploads (playwright-report/), and opening it on failure would hang a
  // headless run.
  reporter: [['list'], ['html', { open: 'never' }]],
  // CI: one worker at a time keeps the e2e run deterministic
  workers: process.env.CI ? 1 : undefined,
  use: {
    baseURL: `http://localhost:${port}`,
    trace: 'retain-on-failure',
  },
  webServer: {
    // `vite preview` serves client/dist, so it has no proxy: every /api call
    // the spec does not stub fails fast instead of reaching the backend.
    command: isPreview
      ? `npm run preview -- --port ${port} --strictPort`
      : `npm run dev -- --port ${port} --strictPort`,
    port,
    // Never attach to a stray server on CI, never attach in preview mode
    // (a dev server on that port would silently undo the point of the run),
    // and never attach when E2E_PORT asked for a specific port: that request
    // means "start here".
    reuseExistingServer: !process.env.CI && !explicitPort && !isPreview,
    timeout: 30_000,
  },
});
