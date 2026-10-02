module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.ts', '**/?(*.)+(spec|test).ts'],
  transform: {
    '^.+\\.ts$': 'ts-jest',
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/**/__tests__/**',
    '!src/**/*.test.ts',
    '!src/**/*.spec.ts',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  // Set just under the current numbers: a ratchet against regressions,
  // not a target. Raise them as coverage grows.
  // Measured when these numbers were last raised: 92.43 statements, 84.33
  // branches, 94.04 functions, 92.49 lines. Jest has no autoUpdate, so the
  // floors are a deliberate commit: raise them when coverage grows.
  coverageThreshold: {
    global: {
      statements: 92,
      branches: 84,
      functions: 94,
      lines: 92,
    },
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
  // The port to Vitest is in flight (docs/plans/server-vitest-migration.md):
  // vitest.config.ts owns the converted files and this list keeps them out of
  // the Jest run, so no file is claimed by both runners. The port's second
  // commit deletes this config instead of extending the list.
  testPathIgnorePatterns: ['/node_modules/', 'src/services/downloadQueue\\.test\\.ts$'],
  // @videodeck/shared and @videodeck/test-infra resolve through their
  // package exports (pnpm workspace symlinks).
  testTimeout: 10000,
  setupFiles: ['<rootDir>/src/test-env.ts'],
  setupFilesAfterEnv: [],
};
