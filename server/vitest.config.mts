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
      // the report otherwise and the real number hides. The excludes mirror
      // the Jest config's collectCoverageFrom, plus the two test-only helpers
      // that are not app code (the client ratchet excludes its src/test/ the
      // same way). src/index.ts stays counted: it is the entry point and the
      // ratchet has always seen its zero.
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.d.ts',
        'src/**/*.test.ts',
        'src/**/*.spec.ts',
        'src/**/__tests__/**',
        'src/test-env.ts',
        'src/test-utils.ts',
      ],
      // Set just under the current numbers: a ratchet against regressions, not
      // a target. Raise them as coverage grows. Measured when these floors were
      // committed, on the v8 provider: 92.26 statements, 85.57 branches, 93.91
      // functions, 92.38 lines. The Jest ratchet this replaces measured 92.43,
      // 84.33, 94.04 and 92.49 with istanbul over a set that still counted the
      // two test-only helpers, so branches rose and the rest moved by less than
      // two tenths of a point.
      thresholds: {
        statements: 92.15,
        branches: 85.45,
        functions: 93.8,
        lines: 92.28,
      },
    },
  },
});
