import babel from '@rolldown/plugin-babel';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import { visualizer } from 'rollup-plugin-visualizer';
import { defineConfig } from 'vitest/config';

// `ANALYZE=1 npm run build` writes a bundle report (dist/stats.html).
// Off by default: the report is a one-off inspection, not a build artifact.
const analyze = process.env.ANALYZE === '1';

// React Compiler 1.0, which memoizes components and hooks automatically, so
// new code does not reach for useMemo or useCallback by hand. The preset ships
// with @vitejs/plugin-react 6, which dropped its inline `babel` option, so the
// compiler rides @rolldown/plugin-babel, the Babel pass of Vite 8's Rolldown.
// Existing manual memoization stays: removing it changes compiler output.
const reactCompiler = babel({ presets: [reactCompilerPreset()] });

const vendorChunks: Record<string, string[]> = {
  'react-vendor': ['react', 'react-dom', 'react-router-dom'],
  'i18n-vendor': ['i18next', 'react-i18next', 'i18next-browser-languagedetector'],
  'ui-vendor': ['@radix-ui/react-select', 'react-hot-toast'],
  'list-vendor': ['react-window'],
};

export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    // Vitest sets mode to 'test', and the compiler stays out of that run: it
    // rewrites every component it compiles, so the v8 coverage of the unit
    // suite would measure the injected memo caches instead of the source the
    // tests were written against (statements fell from 97% to 94% with it in).
    // The compiled output is still exercised end to end, because Playwright
    // drives this same config's dev server.
    ...(mode === 'test' ? [] : [reactCompiler]),
    ...(analyze ? [visualizer({ gzipSize: true })] : []),
  ],
  // @videodeck/shared resolves through its package exports (pnpm workspace).
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
            packages.some((pkg) => id.includes(`/node_modules/${pkg}/`)),
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
    // Unit tests only: the Playwright specs in e2e/ and the in-process
    // integration suite in src/__tests__/ have their own runners/configs.
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: ['src/__tests__/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      // Vitest 3 dropped `all`; without an explicit include, files that no
      // test imports are missing from the report and hide the real numbers.
      include: ['src/**/*.{ts,tsx}'],
      // The in-process integration suite (src/__tests__/) runs under its own
      // runner (vitest.integration.config.ts); its non-test helpers are test
      // infrastructure, not app code, so the unit ratchet must not count them.
      exclude: ['src/**/*.test.{ts,tsx}', 'src/__tests__/**', 'src/test/**', 'src/index.tsx', 'src/vite-env.d.ts'],
      // Set just under the current numbers: a ratchet against regressions,
      // not a target. Raise them as coverage grows.
      thresholds: {
        statements: 98.08,
        branches: 93.61,
        functions: 97.44,
        lines: 98.49,
        // Raising these is a deliberate commit: `autoUpdate` stays off so a
        // gate run never rewrites this tracked file (it used to, which is how
        // CI mutated the repository mid-run).
        autoUpdate: false,
      },
    },
  },
}));
