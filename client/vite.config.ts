import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Types-only module shared with the server (see shared/api.ts)
      '@shared': fileURLToPath(new URL('../shared', import.meta.url)),
    },
  },
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true
      }
    }
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    css: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      // Vitest 3 dropped `all`; without an explicit include, files that no
      // test imports are missing from the report and hide the real numbers.
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/test/**', 'src/index.tsx', 'src/vite-env.d.ts'],
      // Set just under the current numbers: a ratchet against regressions,
      // not a target. Raise them as coverage grows.
      thresholds: {
        statements: 85,
        branches: 78,
        functions: 87,
        lines: 86,
      },
    },
  },
})

