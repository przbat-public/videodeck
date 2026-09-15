import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * Client INTEGRATION suite, in the vita-tracker style: the real <App />
 * rendered in jsdom against the REAL backend booted IN-PROCESS via
 * @videodeck/test-infra (fake Elasticsearch + mock OpenAI + fake yt-dlp +
 * seeded temp folder), with global fetch rewritten to reach it. No browser,
 * no spawned processes: Playwright stays the thin mocked-e2e layer in e2e/.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Types-only module shared with the server (see shared/api.ts)
      '@shared': fileURLToPath(new URL('../shared', import.meta.url)),
      // Shared test infrastructure imported in-process (pnpm workspace);
      // the config file lives in client/, so one level up is the repo root
      '@videodeck/test-infra': fileURLToPath(new URL('../test-infra/src', import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/__tests__/integration/setup.ts'],
    include: ['src/__tests__/integration/**/*.test.{ts,tsx}'],
    css: true,
    pool: 'forks',
    maxWorkers: 1,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
