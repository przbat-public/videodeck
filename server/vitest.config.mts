import { defineConfig } from 'vitest/config';

/**
 * The server suite on Vitest, the runner the client and the extension already
 * use. One runner, one mocking API and one coverage provider for the whole
 * repository (docs/plans/server-vitest-migration.md).
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
    // The two settings the config this one replaces pinned: the app-wide env
    // defaults land before the app module is imported (src/test-env.ts), and a
    // test that crosses a process boundary still gets ten seconds.
    setupFiles: ['./src/test-env.ts'],
    testTimeout: 10_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      reportsDirectory: './coverage',
      // An explicit include, because a file no test imports is missing from
      // the report otherwise and the real number hides. Test files and the two
      // test-only helpers are not app code, and neither is src/index.ts: it is
      // the process entry point (listen, signal wiring, shutdown) that no unit
      // test can run without spawning a server, so counting its zero only
      // diluted the ratchet. The client excludes its own entry (src/index.tsx)
      // for the same reason.
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.d.ts',
        'src/**/*.test.ts',
        'src/**/*.spec.ts',
        'src/**/__tests__/**',
        'src/test-env.ts',
        'src/test-utils.ts',
        'src/index.ts',
      ],
      // Set just under the current numbers: a ratchet against regressions, not
      // a target. Raise them as coverage grows. Measured on the v8 provider over
      // six full runs: 93.27 statements, 86.06 branches, 95.16 functions and
      // 93.41 lines, identical five times, with one run reading 85.94 branches.
      // That single dip is why the branch floor keeps more room than the others:
      // a gate that flakes is worse than a gate that is a third of a point
      // loose. The same run counted src/index.ts before it left the set and read
      // 92.26, 85.57, 93.91 and 92.38, so the ratchet spends the difference on
      // code a test can reach.
      thresholds: {
        statements: 93.1,
        branches: 85.7,
        functions: 95,
        lines: 93.25,
      },
    },
  },
});
