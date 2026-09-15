import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { visualizer } from 'rollup-plugin-visualizer';

// `ANALYZE=1 npm run build` writes a bundle report (dist/stats.html).
// Off by default: the report is a one-off inspection, not a build artifact.
const analyze = process.env.ANALYZE === '1';

const vendorChunks: Record<string, string[]> = {
  'react-vendor': ['react', 'react-dom', 'react-router-dom'],
  'i18n-vendor': ['i18next', 'react-i18next', 'i18next-browser-languagedetector'],
  'ui-vendor': ['@radix-ui/react-select', 'react-hot-toast', 'react-window'],
};

export default defineConfig({
  plugins: [react(), ...(analyze ? [visualizer({ gzipSize: true })] : [])],
  resolve: {
    alias: {
      // Types-only module shared with the server (see shared/api.ts)
      '@shared': fileURLToPath(new URL('../shared', import.meta.url)),
    },
  },
  build: {
    rollupOptions: {
      output: {
        // Stable vendor chunks: framework code changes far less often than
        // app code, so returning users download only the small app chunk.
        manualChunks(id: string): string | undefined {
          if (!id.includes('node_modules')) {
            return undefined;
          }
          const chunk = Object.entries(vendorChunks).find(([, packages]) =>
            packages.some((pkg) => id.includes(`/node_modules/${pkg}/`))
          );
          return chunk?.[0];
        },
      },
    },
  },
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    css: true,
    // Unit tests only: the Playwright specs in e2e/ have their own runner
    include: ['src/**/*.test.{ts,tsx}'],
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
        // Ratchet: `npm run test:coverage` raises these in place whenever
        // coverage grows, so they can only move up. Commit the change.
        autoUpdate: true,
      },
    },
  },
});
