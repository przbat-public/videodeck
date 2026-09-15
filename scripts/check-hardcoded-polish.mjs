#!/usr/bin/env node
// @ts-check
/**
 * Guards against hardcoded Polish UI strings.
 *
 * Every user-facing text must come from the i18n catalogs
 * (client/src/i18n/locales/, chrome-extension/_locales/) — a past miss:
 * components carried literal Polish labels that never switched when the
 * user changed the language.
 *
 * Comments are ignored on purpose: only quoted string literals are checked.
 * Escape hatch: a file containing the marker `polish-ok` is skipped (add a
 * comment with the reason, e.g. `// polish-ok: data sample, not UI`).
 *
 * Wired into `npm run lint`; fails CI with file:line of every violation.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

/** Directories scanned for hardcoded Polish strings */
export const SCAN_DIRS = ['client/src', 'chrome-extension/src'];

/** Files excluded from the scan (tests assert rendered Polish text by design) */
export const SKIP_FILE_RE = /(^|\/)(i18n|_locales)\/|\.test\.|\.spec\./;

const POLISH_CHARS = 'ąćęłńóśźżĄĆĘŁŃÓŚŹŻ';
const QUOTED_STRING_RE = new RegExp(`['"\`]([^'"\`]*[${POLISH_CHARS}][^'"\`]*)['"\`]`, 'g');

/**
 * Remove `//` and `/* *\/` comments (strings are preserved verbatim), so
 * Polish prose in comments does not trigger the check.
 *
 * @param {string} source
 * @returns {string}
 */
export function stripComments(source) {
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
    if (c === '"' || c === "'" || c === '`') {
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

/**
 * The Polish strings found in the source, each as `{ line, text }`.
 * Pure function — unit-tested with fixture content.
 *
 * @param {string} source
 * @returns {Array<{ line: number, text: string }>}
 */
export function findHardcodedPolish(source) {
  const stripped = stripComments(source);
  const hits = [];
  for (const match of stripped.matchAll(QUOTED_STRING_RE)) {
    const line = stripped.slice(0, match.index).split('\n').length;
    hits.push({ line, text: match[1] ?? '' });
  }
  return hits;
}

/** All *.ts/*.tsx files under the scan directories */
export function listSourceFiles(root = ROOT) {
  /** @type {string[]} */
  const files = [];
  /** @param {string} dir */
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.(ts|tsx)$/.test(entry.name) && !SKIP_FILE_RE.test(full)) {
        files.push(full);
      }
    }
  };
  for (const dir of SCAN_DIRS) {
    walk(resolve(root, dir));
  }
  return files;
}

/** CLI: exit 1 listing every violation. */
function main() {
  const violations = [];
  for (const file of listSourceFiles()) {
    const source = readFileSync(file, 'utf-8');
    if (source.includes('polish-ok')) {
      continue;
    }
    for (const hit of findHardcodedPolish(source)) {
      violations.push(`${file}:${hit.line}: ${hit.text}`);
    }
  }
  if (violations.length > 0) {
    console.error(
      `Hardcoded Polish strings found — move them to the i18n catalogs:\n${violations.join('\n')}`
    );
    process.exitCode = 1;
    return;
  }
  console.log('check-hardcoded-polish: OK');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
