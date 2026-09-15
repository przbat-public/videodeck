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
  coverageThreshold: {
    global: {
      statements: 85,
      branches: 75,
      functions: 86,
      lines: 86,
    },
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
  // runtime imports from shared/ (progress, schemas); the test
  // infrastructure resolves through the @videodeck/test-infra package
  // exports (pnpm workspace symlink)
  moduleNameMapper: {
    '^@shared/(.*)$': '<rootDir>/../shared/$1',
  },
  testTimeout: 10000,
  setupFiles: ['<rootDir>/src/test-env.ts'],
  setupFilesAfterEnv: [],
};
