import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Pins the committed architecture diagrams in docs/architecture/ to their
// sources: every JSON must pass the vendored archify showcase validation,
// and a fresh render must equal the committed HTML byte for byte. Archify
// (MIT) is vendored under .agents/skills/archify/ and must never phone
// home, so the update check stays disabled in every invocation.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = path.join(ROOT, '.agents', 'skills', 'archify', 'bin', 'archify.mjs');
const DIAGRAMS = path.join(ROOT, 'docs', 'architecture');

/** Suffix to diagram type, matched by the file naming convention. */
const SUFFIX_TYPES = [
  ['architecture', 'architecture'],
  ['workflow', 'workflow'],
  ['sequence', 'sequence'],
  ['dataflow', 'dataflow'],
  ['lifecycle', 'lifecycle'],
];

/**
 * @param {string[]} args
 * @returns {{ status: number | null; stdout: string; stderr: string }}
 */
const runCli = (args) => {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, ARCHIFY_UPDATE_CHECK_DISABLED: '1' },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

/**
 * @param {string} file
 * @returns {string | undefined}
 */
const diagramTypeOf = (file) => {
  for (const [suffix, type] of SUFFIX_TYPES) {
    if (file.endsWith(`.${suffix}.json`)) return type;
  }
  return undefined;
};

/**
 * @returns {Array<{ type: string; json: string; html: string }>}
 */
const diagramFiles = () =>
  readdirSync(DIAGRAMS)
    .filter((file) => file.endsWith('.json'))
    .map((file) => {
      const type = diagramTypeOf(file);
      assert.ok(type !== undefined, `unrecognized diagram type for docs/architecture/${file}`);
      return {
        type: /** @type {string} */ (type),
        json: path.join(DIAGRAMS, file),
        html: path.join(DIAGRAMS, file.replace(/\.json$/, '.html')),
      };
    });

test('every diagram passes the showcase validation', () => {
  const diagrams = diagramFiles();
  assert.ok(diagrams.length > 0, 'no diagrams found in docs/architecture/');
  for (const diagram of diagrams) {
    const run = runCli(['validate', diagram.type, diagram.json, '--quality', 'showcase', '--json']);
    assert.equal(run.status, 0, `validate failed for ${path.basename(diagram.json)}: ${run.stderr}`);
    const receipt = JSON.parse(run.stdout);
    assert.equal(receipt.ok, true, `validate not ok for ${path.basename(diagram.json)}`);
    const checks = Array.isArray(receipt.checks) ? receipt.checks.length : 0;
    if (diagram.type === 'architecture') {
      assert.equal(
        checks,
        9,
        `showcase validation must report all 9 artifact checks for ${path.basename(diagram.json)}`,
      );
    } else {
      assert.ok(checks > 0, `showcase validation reported no artifact checks for ${path.basename(diagram.json)}`);
    }
  }
});

test('committed HTML matches a fresh render of every diagram', () => {
  const diagrams = diagramFiles();
  const work = mkdtempSync(path.join(tmpdir(), 'videodeck-archify-'));
  try {
    for (const diagram of diagrams) {
      assert.ok(existsSync(diagram.html), `missing committed artifact ${path.basename(diagram.html)}`);
      const out = path.join(work, path.basename(diagram.html));
      const run = runCli(['deliver', diagram.type, diagram.json, out, '--quality', 'showcase', '--json']);
      assert.equal(run.status, 0, `deliver failed for ${path.basename(diagram.json)}: ${run.stderr}`);
      const committed = readFileSync(diagram.html);
      const rendered = readFileSync(out);
      assert.ok(
        committed.equals(rendered),
        `regenerate the committed artifact: ARCHIFY_UPDATE_CHECK_DISABLED=1 node .agents/skills/archify/bin/archify.mjs deliver ${diagram.type} docs/architecture/${path.basename(diagram.json)} docs/architecture/${path.basename(diagram.html)} --quality showcase`,
      );
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
