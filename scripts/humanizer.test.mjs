import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Pins the behavior of the vendored humanizer CLI (scripts/humanizer, MIT,
// https://github.com/Aboudjem/humanizer-skill): deterministic scores, the CI
// gate exit codes and the fact checker the doc rewrites rely on.
const CLI = fileURLToPath(new URL('./humanizer/index.js', import.meta.url));

/**
 * @param {string[]} args
 * @param {string} [input]
 */
const run = (args, input) => {
  const result =
    input === undefined
      ? spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf-8' })
      : spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf-8', input });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

const AI_SMELL =
  'This comprehensive guide delves into the intricate tapestry of our authentication system. Leveraging robust, seamless workflows is crucial. It is important to note that the realm of security is pivotal. Moreover, this multifaceted solution fosters innovation. Furthermore, the interplay of components showcases our commitment. The landscape of modern software demands nothing less.';

const HUMAN = 'The auth service checks the token on every request. If it is missing, you get a 401. Simple as that.';

test('scores AI-flavored prose higher than plain human prose', () => {
  const ai = run(['score', '-', '--json'], AI_SMELL);
  const human = run(['score', '-', '--json'], HUMAN);
  assert.equal(ai.status, 0);
  assert.equal(human.status, 0);
  const aiScore = JSON.parse(ai.stdout).score;
  const humanScore = JSON.parse(human.stdout).score;
  assert.ok(aiScore > humanScore, `expected ${aiScore} > ${humanScore}`);
});

test('scan fails the CI gate when a file scores above the limit', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'humanizer-'));
  try {
    writeFileSync(path.join(dir, 'bad.md'), AI_SMELL);
    const result = run(['scan', path.join(dir, 'bad.md'), '--fail-above', '10']);
    assert.equal(result.status, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scan passes under the gate and flags regressions against a baseline', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'humanizer-'));
  try {
    const file = path.join(dir, 'doc.md');
    writeFileSync(file, HUMAN);
    const baseline = path.join(dir, 'baseline.json');
    assert.equal(run(['scan', file, '--baseline', baseline, '--write-baseline']).status, 0);
    assert.equal(run(['scan', file, '--baseline', baseline, '--fail-on-regression']).status, 0);

    writeFileSync(file, AI_SMELL);
    assert.equal(run(['scan', file, '--baseline', baseline, '--fail-on-regression']).status, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('compare with --check-facts fails when the rewrite dropped a number', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'humanizer-'));
  try {
    const before = path.join(dir, 'before.md');
    const after = path.join(dir, 'after.md');
    writeFileSync(before, 'The service handles 5000 requests per second at p99 40ms.');
    writeFileSync(after, 'The service handles plenty of requests, fast.');
    const result = run(['compare', '--before', before, '--after', after, '--check-facts']);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /5000/);

    writeFileSync(after, 'The service handles 5000 requests per second, p99 at 40ms.');
    assert.equal(run(['compare', '--before', before, '--after', after, '--check-facts']).status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
