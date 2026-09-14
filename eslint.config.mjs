import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import eslintReact from '@eslint-react/eslint-plugin';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import prettierRecommended from 'eslint-plugin-prettier/recommended';
import { defineConfig, globalIgnores } from 'eslint/config';

/**
 * One flat config for the whole repo. Flat config only lints files below the
 * directory holding it, and shared/ sits outside both workspaces — hence a
 * single root config instead of one per package.
 */

/** Rules that server, shared and client all share */
const commonRules = {
  '@typescript-eslint/no-unused-vars': [
    'error',
    { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
  ],
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
          group: ['@shared/api'],
          allowTypeImports: true,
          message: 'shared/api.ts contains types only; use `import type`.',
        },
      ],
    },
  ],
  'no-console': ['warn', { allow: ['warn', 'error'] }],
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
    // react-hooks 7 still ships its presets in eslintrc shape, so the plugin is
    // registered by hand. Its `recommended-latest` adds the whole React
    // Compiler rule set — enable that as a separate, deliberate change.
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      ...commonRules,
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },

  // The logger is the single module that may talk to the console directly.
  {
    files: ['server/src/utils/logger.ts'],
    rules: { 'no-console': 'off' },
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
    rules: {
      ...commonRules,
      // An extension has nowhere else to log
      'no-console': 'off',
    },
  },

  // Must stay last: turns off every rule that would fight Prettier
  prettierRecommended,
]);
