#!/usr/bin/env node
// @ts-check
/**
 * Pins the TypeScript strictness baseline.
 *
 * A past miss: a "temporary" weakening of a strict flag in a tsconfig that
 * silently became permanent. This script fails lint when any required flag
 * is missing or falsy in tsconfig.base.json, and when the per-package flags
 * (isolatedModules/verbatimModuleSyntax) are dropped.
 *
 * To adopt a NEW strict flag:
 *   1. Turn it on in the relevant tsconfig and make the tree green.
 *   2. Add it to REQUIRED (or the per-package expectations) in this file.
 *
 * Wired into `npm run lint`; fails CI with the exact flag that regressed.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

/** Flags every package must keep (via tsconfig.base.json) */
export const REQUIRED_BASE_FLAGS = {
  strict: true,
  exactOptionalPropertyTypes: true,
  noUncheckedIndexedAccess: true,
  noImplicitOverride: true,
  noImplicitReturns: true,
  noUnusedLocals: true,
  noUnusedParameters: true,
  noFallthroughCasesInSwitch: true,
  forceConsistentCasingInFileNames: true,
  skipLibCheck: true,
};

/** Per-package flags the strictness migration has already paid for */
export const PACKAGE_EXPECTATIONS = [
  {
    file: 'client/tsconfig.json',
    flags: { isolatedModules: true, verbatimModuleSyntax: true },
  },
  {
    file: 'chrome-extension/tsconfig.json',
    flags: { isolatedModules: true, verbatimModuleSyntax: true },
  },
  {
    // verbatimModuleSyntax is off here on purpose: without "type":"module"
    // the server compiles ../shared as CommonJS (TS1287). Documented in
    // server/tsconfig.json — isolatedModules stays pinned.
    file: 'server/tsconfig.json',
    flags: { isolatedModules: true },
  },
];

/**
 * Missing/weakened flags in a parsed tsconfig, as `flag: actual` pairs.
 * Pure function — unit-tested with fixture objects.
 *
 * @param {Record<string, unknown>} compilerOptions
 * @param {Record<string, unknown>} required
 * @returns {Record<string, unknown>}
 */
export function findMissingFlags(compilerOptions, required) {
  /** @type {Record<string, unknown>} */
  const missing = {};
  for (const [flag, expected] of Object.entries(required)) {
    if (compilerOptions[flag] !== expected) {
      missing[flag] = compilerOptions[flag];
    }
  }
  return missing;
}

/** @param {string} file */
function readJson(file) {
  return JSON.parse(stripJsonComments(readFileSync(resolve(ROOT, file), 'utf-8')));
}

/**
 * tsconfig files are JSONC: strip `//` and `/* *\/` comments (string-aware,
 * so a `"@/*"`-style path cannot break the naive version).
 *
 * @param {string} source
 * @returns {string}
 */
export function stripJsonComments(source) {
  let out = '';
  let i = 0;
  let inLine = false;
  let inBlock = false;
  let quote = null;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1] ?? '';
    if (inLine) {
      if (c === '\n') {
        inLine = false;
        out += c;
      }
      i += 1;
      continue;
    }
    if (inBlock) {
      if (c === '*' && next === '/') {
        inBlock = false;
        out += '  ';
        i += 2;
        continue;
      }
      if (c === '\n') out += c;
      i += 1;
      continue;
    }
    if (quote !== null) {
      out += c;
      if (c === '\\') {
        out += next;
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (c === '/' && next === '/') {
      inLine = true;
      i += 2;
      continue;
    }
    if (c === '/' && next === '*') {
      inBlock = true;
      i += 2;
      continue;
    }
    if (c === '"') {
      quote = c;
      out += c;
      i += 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** CLI: exit 1 listing every weakened flag. */
function main() {
  const problems = [];
  const base = readJson('tsconfig.base.json').compilerOptions ?? {};
  for (const [flag, actual] of Object.entries(findMissingFlags(base, REQUIRED_BASE_FLAGS))) {
    problems.push(`tsconfig.base.json: ${flag} is ${JSON.stringify(actual)}, expected true`);
  }
  for (const { file, flags } of PACKAGE_EXPECTATIONS) {
    const compilerOptions = readJson(file).compilerOptions ?? {};
    for (const [flag, actual] of Object.entries(findMissingFlags(compilerOptions, flags))) {
      problems.push(`${file}: ${flag} is ${JSON.stringify(actual)}, expected true`);
    }
  }
  if (problems.length > 0) {
    console.error(`TypeScript strictness baseline regressed:\n${problems.join('\n')}`);
    process.exitCode = 1;
    return;
  }
  console.log('check-tsconfig-strict: OK');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
