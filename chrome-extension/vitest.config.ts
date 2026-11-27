import { defineConfig } from 'vitest/config';

// @videodeck/shared resolves through its package exports (pnpm workspace).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      // The service worker, the content script, the popup and the options page
      // were outside every gate until this block existed.
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
      // A ratchet against regressions, not a target: the numbers sit just under
      // what the suite measures today, and raising them is a deliberate commit
      // (`autoUpdate` stays off so a gate run never rewrites this file).
      // Measured once popup.test.ts landed: 67.34 statements, 48.62 branches,
      // 54.54 functions, 68.51 lines, and each floor sits a point under the
      // whole number. `popup.ts` is covered now (it runs in jsdom against the
      // real popup.html); `lib/messages.ts` holds only types, with no code to run.
      thresholds: {
        statements: 66,
        branches: 47,
        functions: 53,
        lines: 67,
        autoUpdate: false,
      },
    },
  },
});
