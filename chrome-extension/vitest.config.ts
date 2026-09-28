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
      // Measured when the gate was added: 38.54 statements, 31.37 branches,
      // 34.84 functions, 39.12 lines. The floors sit one point under. The gap
      // is honest: `popup.ts` and `lib/messages.ts` have no test at all yet.
      thresholds: {
        statements: 38,
        branches: 31,
        functions: 34,
        lines: 39,
        autoUpdate: false,
      },
    },
  },
});
