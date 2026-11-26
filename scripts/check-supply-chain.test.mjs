import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// pnpm keeps a freshly published version out of the lockfile for
// `minimumReleaseAge` minutes, which is the window in which most hijacked
// releases get caught and pulled. pnpm 12 ships a 1440-minute default but
// keeps it lenient: what it cannot satisfy it quietly excludes. A value
// written in pnpm-workspace.yaml is strict, which is the point of writing it.
// Dependabot then has to wait at least as long, or every fresh bump it opens
// fails the strict install in CI.
//
// Parsed with regular expressions instead of a YAML dependency, like the
// compose check: both files are ours and the shapes below are the only ones
// the gate accepts.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WORKSPACE = readFileSync(path.join(ROOT, 'pnpm-workspace.yaml'), 'utf8');
const DEPENDABOT = readFileSync(path.join(ROOT, '.github', 'dependabot.yml'), 'utf8');
const MINUTES_PER_DAY = 1440;

/** The explicit `minimumReleaseAge` of the workspace, in minutes */
function releaseAgeMinutes() {
  const match = /^minimumReleaseAge:\s*(\d+)\s*$/m.exec(WORKSPACE);
  assert.ok(match, 'pnpm-workspace.yaml must set minimumReleaseAge explicitly');
  return Number(match[1]);
}

/** The body of the `package-ecosystem: npm` entry of dependabot.yml */
function npmEntry() {
  const entry = DEPENDABOT.split(/\n {2}- /).find((block) => /^package-ecosystem:\s*npm\s*$/m.test(block));
  assert.ok(entry, '.github/dependabot.yml has no npm entry');
  return entry;
}

test('pnpm holds a fresh release back for at least a day', () => {
  const minutes = releaseAgeMinutes();
  assert.ok(minutes >= MINUTES_PER_DAY, `minimumReleaseAge is ${minutes} minutes; the gate needs at least a day`);
});

test('Dependabot waits at least as long as the pnpm release-age gate', () => {
  const days = /\n {4}cooldown:\s*\n {6}default-days:\s*(\d+)\s*$/m.exec(npmEntry());
  assert.ok(days, 'the npm entry of .github/dependabot.yml needs `cooldown: default-days: <n>`');
  const minutes = Number(days[1]) * MINUTES_PER_DAY;
  assert.ok(
    minutes >= releaseAgeMinutes(),
    `a ${days[1]}-day cooldown is shorter than minimumReleaseAge (${releaseAgeMinutes()} minutes)`,
  );
});
