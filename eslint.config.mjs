import js from '@eslint/js';
import eslintReact from '@eslint-react/eslint-plugin';
import { defineConfig, globalIgnores } from 'eslint/config';
import biome from 'eslint-config-biome';
import playwright from 'eslint-plugin-playwright';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * One flat config for the whole repo. Flat config only lints files below the
 * directory holding it, and shared/ sits outside both workspaces — hence a
 * single root config instead of one per package.
 */

/** Rules that server, shared and client all share */
const commonRules = {
  '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
  '@typescript-eslint/explicit-function-return-type': 'off',
  '@typescript-eslint/explicit-module-boundary-types': 'off',
  '@typescript-eslint/no-explicit-any': 'error',
  '@typescript-eslint/consistent-type-imports': [
    'error',
    {
      prefer: 'type-imports',
      fixStyle: 'separate-type-imports',
      disallowTypeAnnotations: false,
    },
  ],
  '@typescript-eslint/no-restricted-imports': [
    'error',
    {
      patterns: [
        {
          group: ['@videodeck/shared/api'],
          allowTypeImports: true,
          message: '@videodeck/shared/api contains types only; use `import type`.',
        },
      ],
    },
  ],
};

export default defineConfig([
  globalIgnores([
    '**/node_modules/**',
    '**/dist/**',
    '**/coverage/**',
    '**/*.config.js',
    '**/*.config.ts',
    // Build output of the extension (npm run build in chrome-extension/)
    'chrome-extension/*.js',
  ]),

  // Server and the shared type-only module: Node globals
  {
    files: ['server/src/**/*.ts', 'shared/**/*.ts'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.node,
    },
    rules: commonRules,
  },

  /*
   * `react-hooks/set-state-in-effect` over-reports. It flags every effect
   * whose call chain contains setState, an async loader that only updates
   * state after its await included: a minimal reproduction of exactly that
   * shape is reported as well. The three fetch-on-mount hooks in client/src
   * therefore carry a per-line disable naming that reason, instead of the
   * rule being switched off, so the shape the rule is named after (a
   * synchronous setState in an effect body) is still caught.
   */

  // Client: browser globals plus the React rule set
  {
    files: ['client/src/**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      // eslint-plugin-react does not run on ESLint 10 (it calls the removed
      // context.getFilename), so React rules come from @eslint-react instead.
      eslintReact.configs['recommended-typescript'],
    ],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    // Tell the plugin which React version the code targets; React 19 ref-as-
    // prop means forwardRef is gone from the codebase.
    settings: { 'react-x': { version: '19.0.0' } },
    // react-hooks 7 ships flat presets, so the whole React Compiler rule set
    // (purity, immutability, refs, set-state-in-effect, preserve-manual-
    // memoization and the rest) comes from `configs.flat['recommended-latest']`
    // rather than a hand-registered pair of rules. It is a superset of
    // `recommended`, so the newest lint earns its place here.
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      ...commonRules,
      ...reactHooks.configs.flat['recommended-latest'].rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },

  // Chrome extension: browser + WebExtension globals. The generated *.js at
  // the extension root (build output) is ignored above; only src/*.ts is
  // linted.
  {
    files: ['chrome-extension/src/**/*.ts'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.webextensions },
    },
    rules: commonRules,
  },

  // The route table is data, not a refreshable component module — react-refresh
  // would demand splitting the lazy components out of it.
  {
    files: ['client/src/routes.tsx'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },

  // Playwright E2E specs: the runner's recommended rules catch the classic
  // mistakes (no-wait-for-timeout, prefer-web-first-assertions, …). These
  // files used to be linted by the generic TS block only.
  {
    files: ['client/e2e/**/*.ts'],
    extends: [js.configs.recommended, tseslint.configs.recommended, playwright.configs['flat/recommended']],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node },
    },
    rules: commonRules,
  },

  // Must stay last: turns off every rule that would fight Biome.
  /** @type {any} */ (biome),
]);
