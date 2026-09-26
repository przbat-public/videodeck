#!/usr/bin/env node
// @ts-check
/**
 * Guards the test suite against assertions that cannot fail and waits that
 * only look like synchronisation. A test-quality audit paid for every rule
 * here:
 *
 * - `no-bare-sleep`: a `sleep(` helper, defined or called, instead of waiting
 *   for a signal the app itself emits.
 * - `no-hand-rolled-sleep`: `await new Promise(... setTimeout ...)` inline in
 *   a test body. A predicate poll inside a named helper is the sanctioned
 *   fallback; a fixed delay in the middle of a test is not.
 * - `no-wait-for-timeout`: Playwright's `waitForTimeout(`.
 * - `no-focused-test`: `.only(`, which silently drops the rest of the file
 *   from CI.
 * - `no-heading-wait-for-clicked-link`: waiting for a heading whose accessible
 *   name is the card link the same file clicked. The list renders that name
 *   too, so the query is already satisfied before the navigation and cannot
 *   tell the detail page from the list. Assert a state only the new page has.
 * - `no-cannot-fail-query-assertion`: `expect(await screen.queryBy…()).toBeDefined()`
 *   passes for `null`, so a missing element satisfies it.
 *
 * Comments are ignored on purpose (the scan runs on comment-stripped source).
 * Escape hatch: a file containing the marker `test-hygiene-ok` is skipped (add
 * a comment with the reason, e.g. `// test-hygiene-ok: the fixed delay is the
 * asserted behaviour`).
 *
 * Wired into `pnpm run lint`; fails CI with file:line of every violation.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments as stripAllComments } from './strip-comments.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

/** Directories walked for test files */
export const SCAN_DIRS = ['server/src', 'client/src', 'client/e2e', 'chrome-extension/src', 'test-infra/src'];

/** Only test files are checked: unit, integration and the Playwright specs */
export const TEST_FILE_RE = /\.test\.tsx?$|(^|\/)e2e\/.*\.spec\.ts$/;

/** File marker for a deliberate exception, in the `polish-ok` spirit */
export const EXEMPT_MARKER = 'test-hygiene-ok';

const SLEEP_RE = /\bsleep\s*\(|\b(?:const|let|var|function)\s+sleep\b/g;
const HAND_ROLLED_SLEEP_RE = /await\s+new\s+Promise\s*(?:<[^>]*>)?\s*\([\s\S]{0,160}?setTimeout\s*\(/g;
const WAIT_FOR_TIMEOUT_RE = /\bwaitForTimeout\s*\(/g;
const FOCUSED_RE = /\.\s*only\s*\(/g;
const CANNOT_FAIL_QUERY_RE = /expect\s*\(\s*await\s+[^;]{0,200}?query(?:All)?By[^;]{0,200}?\)\s*\.\s*toBeDefined\s*\(/g;
const ROLE_QUERY_RE =
  /(?:get|find|query)(?:All)?ByRole\(\s*'([a-z]+)'\s*,\s*\{\s*name:\s*(\/[^/\n]*\/[a-z]*|'[^'\n]*'|"[^"\n]*"|`[^`\n]*`)\s*\}/g;

/**
 * Remove `//` and block comments (strings are preserved verbatim), so prose
 * about a sleep or a `.only` does not trip the scan.
 *
 * @param {string} source
 * @returns {string}
 */
export function stripComments(source) {
  return stripAllComments(source, '"\'`');
}

/**
 * 1-based line number of a character offset.
 *
 * @param {string} source
 * @param {number} index
 * @returns {number}
 */
function lineOf(source, index) {
  return source.slice(0, index).split('\n').length;
}

/**
 * The plain text an accessible-name matcher looks for: quotes and backticks
 * are dropped, `/pattern/flags` keeps only the pattern.
 *
 * @param {string} raw
 * @returns {string}
 */
export function matcherText(raw) {
  const trimmed = raw.trim();
  if (trimmed.startsWith('/')) {
    return trimmed.slice(1, trimmed.lastIndexOf('/'));
  }
  return trimmed.slice(1, -1);
}

/**
 * The character range of a balanced `(` … `)`, skipping string literals.
 *
 * @param {string} source
 * @param {number} openIndex
 * @returns {number} index of the closing paren, or -1
 */
function matchClose(source, openIndex) {
  let depth = 0;
  let i = openIndex;
  while (i < source.length) {
    const char = source[i] ?? '';
    if (char === '"' || char === "'" || char === '`') {
      i = skipString(source, i);
      continue;
    }
    if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
    i += 1;
  }
  return -1;
}

/**
 * The offset just past the string literal that starts at `start`.
 *
 * @param {string} source
 * @param {number} start
 * @returns {number}
 */
function skipString(source, start) {
  const quote = source[start];
  let i = start + 1;
  while (i < source.length) {
    const char = source[i] ?? '';
    if (char === '\\') {
      i += 2;
      continue;
    }
    i += 1;
    if (char === quote) {
      break;
    }
  }
  return i;
}

/**
 * The character ranges of every `it(...)` / `test(...)` callback body, so a
 * rule can stay inside test bodies (a helper that polls a predicate is not a
 * synchronisation sleep).
 *
 * @param {string} source
 * @returns {Array<[number, number]>}
 */
export function testBodyRanges(source) {
  /** @type {Array<[number, number]>} */
  const ranges = [];
  for (const match of source.matchAll(/(?:^|[^\w$.])(it|test)\s*\(/g)) {
    const open = source.indexOf('(', match.index + match[0].length - 1);
    const close = open === -1 ? -1 : matchClose(source, open);
    if (close !== -1) {
      ranges.push([open, close]);
    }
  }
  return ranges;
}

/**
 * @typedef {{ index: number, text: string, name: string }} HeadingWait
 * @typedef {{ stripped: string, lines: string[], report: (rule: string, index: number, text: string) => void }} ScanContext
 */

/**
 * Every match of `pattern` in the stripped source, reported under `rule`.
 *
 * @param {RegExp} pattern
 * @param {string} rule
 * @param {ScanContext} context
 */
function reportMatches(pattern, rule, context) {
  for (const match of context.stripped.matchAll(pattern)) {
    context.report(rule, match.index, match[0]);
  }
}

/**
 * Heading waits whose accessible name is a link the same file clicks: the list
 * renders that name too, so the query is satisfied before the navigation.
 *
 * @param {ScanContext} context
 * @returns {HeadingWait[]}
 */
function headingWaitsOnClickedLinks(context) {
  const clickedLinks = new Set();
  /** @type {HeadingWait[]} */
  const headings = [];
  for (const match of context.stripped.matchAll(ROLE_QUERY_RE)) {
    const role = match[1] ?? '';
    const name = matcherText(match[2] ?? '');
    const line = context.lines[lineOf(context.stripped, match.index) - 1] ?? '';
    if (role === 'link' && line.includes('click')) {
      clickedLinks.add(name);
    }
    if (role === 'heading' && name.length > 0) {
      headings.push({ index: match.index, text: match[0], name });
    }
  }
  return headings.filter((heading) => clickedLinks.has(heading.name));
}

/**
 * Every hygiene violation in one test file, each as `{ line, rule, text }`.
 * Pure function, unit-tested with fixture sources.
 *
 * @param {string} source
 * @returns {Array<{ line: number, rule: string, text: string }>}
 */
export function findTestHygieneViolations(source) {
  const stripped = stripComments(source);
  const bodies = testBodyRanges(stripped);
  /** @type {Array<{ line: number, rule: string, text: string }>} */
  const violations = [];
  /** @type {ScanContext} */
  const context = {
    stripped,
    lines: stripped.split('\n'),
    report: (rule, index, text) => {
      violations.push({ line: lineOf(stripped, index), rule, text: text.trim().replace(/\s+/g, ' ') });
    },
  };

  reportMatches(SLEEP_RE, 'no-bare-sleep', context);
  reportMatches(WAIT_FOR_TIMEOUT_RE, 'no-wait-for-timeout', context);
  reportMatches(FOCUSED_RE, 'no-focused-test', context);
  reportMatches(CANNOT_FAIL_QUERY_RE, 'no-cannot-fail-query-assertion', context);
  // A predicate poll in a named helper is the sanctioned fallback, so this one
  // only counts inside a test body.
  for (const match of stripped.matchAll(HAND_ROLLED_SLEEP_RE)) {
    if (bodies.some(([start, end]) => match.index > start && match.index < end)) {
      context.report('no-hand-rolled-sleep', match.index, match[0]);
    }
  }
  for (const heading of headingWaitsOnClickedLinks(context)) {
    context.report('no-heading-wait-for-clicked-link', heading.index, heading.text);
  }

  return violations.sort((left, right) => left.line - right.line);
}

/**
 * Every test file under the scan directories.
 *
 * @param {string} root
 * @returns {string[]}
 */
export function listTestFiles(root = ROOT) {
  /** @type {string[]} */
  const files = [];
  /** @param {string} dir */
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (TEST_FILE_RE.test(full)) {
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
  for (const file of listTestFiles()) {
    const source = readFileSync(file, 'utf-8');
    if (source.includes(EXEMPT_MARKER)) {
      continue;
    }
    for (const hit of findTestHygieneViolations(source)) {
      violations.push(`${file}:${hit.line}: ${hit.rule}: ${hit.text}`);
    }
  }
  if (violations.length > 0) {
    console.error(
      `Test hygiene violations found — see .agents/skills/test-driven-development:\n${violations.join('\n')}`,
    );
    process.exitCode = 1;
    return;
  }
  console.log('check-test-hygiene: OK');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
