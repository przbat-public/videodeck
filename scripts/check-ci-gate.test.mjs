import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// The ruleset on `main` requires checks by name, and GitHub counts a skipped
// job as a pass. Two holes follow from that. A job added to ci.yml gates
// nothing until someone also edits the ruleset (the Docker and production
// bundle jobs never made it in). And when the `changes` job fails, every job
// that needs it is skipped, so a pull request whose pipeline never ran can
// still merge. One `ci-ok` job closes both: it runs whatever happened, needs
// every other job, and fails unless each of them passed, or was skipped
// because the change touched documentation only. In the ruleset, `CI ok`
// then stands for every ci.yml job; dependency-review and CodeQL live in
// other workflows, which `needs` cannot reach, so they stay required by name.
//
// Parsed by indentation, like the compose check: the file is ours. The step's
// own script is then run against fixture results, so the verdict is tested,
// not just its spelling.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CI = readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');

/**
 * Every job of ci.yml as `{ id, body }`.
 *
 * @returns {{ id: string; body: string }[]}
 */
function ciJobs() {
  const lines = CI.split('\n');
  const start = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  assert.notEqual(start, -1, 'ci.yml has no top-level `jobs:` block');
  /** @type {{ id: string; body: string }[]} */
  const jobs = [];
  /** @type {{ id: string; body: string } | null} */
  let current = null;
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) {
      break;
    }
    const header = /^ {2}([a-zA-Z0-9_-]+):\s*$/.exec(line);
    if (header) {
      current = { id: header[1] ?? '', body: '' };
      jobs.push(current);
      continue;
    }
    if (current) {
      current.body += `${line}\n`;
    }
  }
  return jobs;
}

/** The `ci-ok` job's body, failing the test when the job is missing */
function ciOkBody() {
  const job = ciJobs().find((candidate) => candidate.id === 'ci-ok');
  assert.ok(job, 'ci.yml needs a `ci-ok` job that gathers every other job');
  return job.body;
}

test('ci-ok runs whatever happened to the jobs it waits for', () => {
  assert.match(
    ciOkBody(),
    /^ {4}if: always\(\)\s*$/m,
    'ci-ok must run with `if: always()`: without it a failed `changes` job skips ci-ok too, and a skipped check passes',
  );
});

/**
 * The job ids a job body lists under `needs:`, inline (`[a, b]`) or as a
 * block sequence (`- a` per line).
 *
 * @param {string} body
 * @returns {string[]}
 */
function needsOf(body) {
  const inline = /^ {4}needs:\s*\[([^\]]*)\]/m.exec(body);
  if (inline) {
    return (inline[1] ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);
  }
  const block = /^ {4}needs:\s*\n((?: {6}- [\w-]+\s*\n)+)/m.exec(body);
  assert.ok(block, 'ci-ok must list the jobs it needs');
  return [...(block[1] ?? '').matchAll(/- ([\w-]+)/g)].map((match) => match[1] ?? '');
}

test('ci-ok waits for every other job in the workflow', () => {
  const listed = new Set(needsOf(ciOkBody()));
  const missing = ciJobs()
    .map((job) => job.id)
    .filter((id) => id !== 'ci-ok' && !listed.has(id));
  assert.deepEqual(missing, [], `ci-ok does not wait for: ${missing.join(', ')}`);
});

/** The script of ci-ok's `run: |` step, without the YAML indentation */
function ciOkScript() {
  const match = /^ {8}run: \|\n((?: {10}.*\n|\s*\n)+)/m.exec(ciOkBody());
  assert.ok(match, 'ci-ok must judge the jobs in one `run: |` step');
  return (match[1] ?? '')
    .split('\n')
    .map((line) => line.slice(10))
    .join('\n');
}

const HAS_JQ = spawnSync('jq', ['--version']).status === 0;

/**
 * The exit status of ci-ok's script for one set of job results, run the way
 * the runner runs it (bash, errexit, pipefail).
 *
 * @param {Record<string, string>} results job id to its result
 * @param {boolean} docsOnly what `DOCS_ONLY` evaluates to for that run
 */
function verdict(results, docsOnly) {
  const needs = Object.fromEntries(Object.entries(results).map(([id, result]) => [id, { result, outputs: {} }]));
  const run = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', ciOkScript()], {
    env: { PATH: process.env.PATH ?? '', RESULTS: JSON.stringify(needs), DOCS_ONLY: String(docsOnly) },
    encoding: 'utf8',
  });
  return run.status;
}

test('ci-ok tells a documentation-only skip from a skip it must not accept', () => {
  assert.match(
    ciOkBody(),
    /^ {10}DOCS_ONLY: \$\{\{ needs\.changes\.outputs\.code == 'false' \}\}\s*$/m,
    "ci-ok must take DOCS_ONLY from the `changes` verdict: `${{ needs.changes.outputs.code == 'false' }}`",
  );
});

test('ci-ok passes or fails the run the way the gate intends', { skip: HAS_JQ ? false : 'jq is not installed' }, () => {
  const green = { changes: 'success', lint: 'success', 'unit-tests': 'success', build: 'success' };
  const docsOnly = { changes: 'success', lint: 'success', 'unit-tests': 'success', build: 'skipped' };

  assert.equal(verdict(green, false), 0, 'every job passed');
  assert.equal(verdict(docsOnly, true), 0, 'a documentation-only change skips the heavy jobs');
  assert.equal(verdict(docsOnly, false), 1, 'a skip is a failure when the change touched code');
  assert.equal(verdict({ ...green, changes: 'failure', build: 'skipped' }, false), 1, 'change detection failed');
  assert.equal(verdict({ ...green, build: 'failure' }, false), 1, 'a job failed');
  assert.equal(verdict({ ...green, build: 'cancelled' }, false), 1, 'a job was cancelled');
});
