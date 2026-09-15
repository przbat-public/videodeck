import { defineConfig } from 'vitest/config';

// @videodeck/shared resolves through its package exports (pnpm workspace).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
