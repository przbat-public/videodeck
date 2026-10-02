import { defineConfig } from 'vitest/config';

/**
 * The server suite on Vitest, the runner the client and the extension already
 * use. The include list is narrow on purpose while the port from Jest is in
 * flight (docs/plans/server-vitest-migration.md): this config owns the files
 * that are already converted, jest.config.js ignores exactly those, so both
 * runners stay green until the port's second commit widens the list and
 * deletes Jest.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/services/downloadQueue.test.ts'],
    // The same two settings jest.config.js pinned: the app-wide env defaults
    // land before the app module is imported (src/test-env.ts), and a test
    // that crosses a process boundary still gets ten seconds.
    setupFiles: ['./src/test-env.ts'],
    testTimeout: 10_000,
  },
});
