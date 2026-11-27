import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { reactCompiler } from './vite.config.ts';

/**
 * Client INTEGRATION suite, in the vita-tracker style: the real <App />
 * rendered in jsdom against the REAL backend booted IN-PROCESS via
 * @videodeck/test-infra (fake Elasticsearch + mock OpenAI + fake yt-dlp +
 * seeded temp folder), with global fetch rewritten to reach it. No browser,
 * no spawned processes: Playwright stays the thin mocked-e2e layer in e2e/.
 * @videodeck/shared and @videodeck/test-infra resolve through their package
 * exports (pnpm workspace symlinks).
 *
 * The components run through React Compiler, the same pass the shipped bundle
 * gets (vite.config.ts), so a journey exercises the compiled code users run.
 * compiler.integration.test.ts fails if that pass goes missing here.
 */
export default defineConfig({
  plugins: [react(), reactCompiler],
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
