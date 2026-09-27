import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// The prose gate in package.json takes an explicit list of files, so a new
// document is scored only when somebody remembers to add it. That is how the
// landing page and the plans stayed outside the scan. This check turns the
// memory into an invariant: every prose file in the repo is either listed in
// `humanizer:gate` or exempt here, with a reason, and no exemption is stale.
//
// Prose means Markdown anywhere plus the HTML documents under docs/. The HTML
// of the client and the extension is application markup, not prose, so it is
// exempt: the copy inside it is governed by the i18n catalogs and the
// hardcoded-Polish scan instead.
const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Directories that never hold our prose. */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', 'test-results', 'playwright-report', '.git']);

/**
 * Prose the gate deliberately does not scan, each with the reason why. An
 * entry may narrow itself to one extension; without one it covers the whole
 * directory.
 *
 * @type {{ prefix: string; extension?: string; reason: string }[]}
 */
const EXEMPT = [
  {
    prefix: '.agents/',
    reason:
      'repo-scoped skills, personas and references: check-skills.test.mjs already pins their frontmatter and the no-em-dash rule',
  },
  {
    prefix: 'docs/architecture/',
    reason: 'archify diagrams generated from the committed JSON, not written prose',
  },
];

/**
 * @param {string} file
 * @returns {boolean}
 */
const isProse = (file) => {
  if (file.endsWith('.md')) {
    return true;
  }
  return file.startsWith(`docs${path.sep}`) && file.endsWith('.html');
};

/**
 * @param {string} file
 * @returns {boolean}
 */
const isExempt = (file) =>
  EXEMPT.some(
    (entry) => file.startsWith(entry.prefix) && (entry.extension === undefined || file.endsWith(entry.extension)),
  );

/**
 * Every prose file under a directory, relative to the repo root.
 *
 * @param {string} dir
 * @returns {string[]}
 */
function walk(dir) {
  /** @type {string[]} */
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) {
        out.push(...walk(full));
      }
      continue;
    }
    const relative = path.relative(ROOT, full);
    if (isProse(relative)) {
      out.push(relative);
    }
  }
  return out;
}

/**
 * The files the gate script passes to the scanner.
 *
 * @returns {string[]}
 */
function gatedFiles() {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const script = String(pkg.scripts['humanizer:gate']);
  const tokens = script.split(/\s+/);
  const start = tokens.indexOf('scan');
  assert.notEqual(start, -1, 'package.json: humanizer:gate must call the scanner with `scan`');
  /** @type {string[]} */
  const files = [];
  for (const token of tokens.slice(start + 1)) {
    if (token.startsWith('--')) {
      break;
    }
    files.push(token);
  }
  return files;
}

const allProse = walk(ROOT).sort();
const candidates = allProse.filter((file) => !isExempt(file));
const gated = gatedFiles();

test('every prose file is either gated or exempt with a reason', () => {
  const missing = candidates.filter((file) => !gated.includes(file));
  assert.deepEqual(
    missing,
    [],
    `not covered by pnpm run humanizer:gate: ${missing.join(', ')}. ` +
      'Add the file to the humanizer:gate list in package.json, or add an exemption with a reason in this test.',
  );
});

test('the gate lists only prose files that exist', () => {
  const stale = gated.filter((file) => {
    try {
      return !statSync(path.join(ROOT, file)).isFile();
    } catch {
      return true;
    }
  });
  assert.deepEqual(stale, [], `humanizer:gate lists files that are gone: ${stale.join(', ')}`);
});

test('no exemption is stale', () => {
  for (const entry of EXEMPT) {
    const covered = allProse.filter(
      (file) => file.startsWith(entry.prefix) && (entry.extension === undefined || file.endsWith(entry.extension)),
    );
    assert.ok(covered.length > 0, `exemption for ${entry.prefix} matches no prose file; drop it from this test`);
  }
});
