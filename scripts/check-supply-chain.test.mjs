import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// What reaches the lockfile and the runners, and who gets to know about it.
//
// Release age: pnpm keeps a freshly published version out of the lockfile for
// `minimumReleaseAge` minutes, which is the window in which most hijacked
// releases get caught and pulled. pnpm 12 ships a 1440-minute default but
// keeps it lenient: what it cannot satisfy it quietly excludes. A value
// written in pnpm-workspace.yaml is strict, which is the point of writing it.
// Dependabot then has to wait at least as long, or every fresh bump it opens
// fails the strict install in CI.
//
// Visibility: GitHub's dependency graph reads only the first YAML document of
// pnpm-lock.yaml. pnpm 12 puts a document about its own version there, so the
// graph saw 15 pnpm packages and none of the 700 the app runs on, and
// Dependabot raised no alert for any of them. `pmOnFail: ignore` keeps that
// document out.
//
// Actions: Dependabot reads only the directories it is given, and the root
// alone skips the composite action, so one action ended up pinned to two
// releases.
//
// Parsed with regular expressions instead of a YAML dependency, like the
// compose check: the files are ours and the shapes below are the only ones
// the gate accepts.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (/** @type {string[]} */ ...parts) => readFileSync(path.join(ROOT, ...parts), 'utf8');
const WORKSPACE = read('pnpm-workspace.yaml');
const DEPENDABOT = read('.github', 'dependabot.yml');
const MINUTES_PER_DAY = 1440;

/** The explicit `minimumReleaseAge` of the workspace, in minutes */
function releaseAgeMinutes() {
  const match = /^minimumReleaseAge:\s*(\d+)\s*$/m.exec(WORKSPACE);
  assert.ok(match, 'pnpm-workspace.yaml must set minimumReleaseAge explicitly');
  return Number(match[1]);
}

/**
 * The body of one `package-ecosystem` entry of dependabot.yml.
 *
 * @param {string} ecosystem
 */
function dependabotEntry(ecosystem) {
  const entry = DEPENDABOT.split(/\n {2}- /).find((block) =>
    new RegExp(`^package-ecosystem:\\s*${ecosystem}\\s*$`, 'm').test(block),
  );
  assert.ok(entry, `.github/dependabot.yml has no ${ecosystem} entry`);
  return entry;
}

/** Every workflow and composite action file, relative to the repo root */
function actionFiles() {
  const workflows = readdirSync(path.join(ROOT, '.github', 'workflows'))
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => path.join('.github', 'workflows', name));
  // Directories only: a README or a Finder .DS_Store next to them is no action
  const composites = readdirSync(path.join(ROOT, '.github', 'actions'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join('.github', 'actions', entry.name, 'action.yml'));
  return [...workflows, ...composites];
}

test('pnpm holds a fresh release back for at least a day', () => {
  const minutes = releaseAgeMinutes();
  assert.ok(minutes >= MINUTES_PER_DAY, `minimumReleaseAge is ${minutes} minutes; the gate needs at least a day`);
});

test('Dependabot waits at least as long as the pnpm release-age gate', () => {
  const days = /\n {4}cooldown:\s*\n {6}default-days:\s*(\d+)\s*$/m.exec(dependabotEntry('npm'));
  assert.ok(days, 'the npm entry of .github/dependabot.yml needs `cooldown: default-days: <n>`');
  const minutes = Number(days[1]) * MINUTES_PER_DAY;
  assert.ok(
    minutes >= releaseAgeMinutes(),
    `a ${days[1]}-day cooldown is shorter than minimumReleaseAge (${releaseAgeMinutes()} minutes)`,
  );
});

test('the lockfile is one YAML document, so GitHub reads all of it', () => {
  assert.match(
    WORKSPACE,
    /^pmOnFail:\s*ignore\s*$/m,
    'pnpm-workspace.yaml must set `pmOnFail: ignore`, or pnpm writes its own version document back into the lockfile',
  );
  const lockfile = read('pnpm-lock.yaml');
  assert.ok(lockfile.startsWith('lockfileVersion:'), 'pnpm-lock.yaml must open with the resolved tree');
  assert.doesNotMatch(lockfile, /^---\s*$/m, 'pnpm-lock.yaml holds a second YAML document GitHub would never read');
});

test('Dependabot watches every composite action', () => {
  const directories = /^ {4}directories:\s*\[([^\]]*)\]\s*$/m.exec(dependabotEntry('github-actions'));
  assert.ok(directories, 'the github-actions entry must list `directories: [...]`');
  const listed = (directories[1] ?? '').split(',').map((entry) => entry.trim().replace(/^['"]|['"]$/g, ''));
  assert.ok(listed.includes('/'), 'the github-actions entry must still cover the workflows (`/`)');
  assert.ok(
    listed.includes('/.github/actions/*'),
    'the github-actions entry must cover the composite actions (`/.github/actions/*`)',
  );
});

test('each action is pinned to one release across workflows and composites', () => {
  /** @type {Map<string, Set<string>>} */
  const pins = new Map();
  for (const file of actionFiles()) {
    for (const match of read(file).matchAll(/uses:\s*([\w.-]+\/[\w./-]+)@([0-9a-f]{40})/g)) {
      const action = match[1] ?? '';
      const shas = pins.get(action) ?? new Set();
      shas.add(match[2] ?? '');
      pins.set(action, shas);
    }
  }
  const drifted = [...pins].filter(([, shas]) => shas.size > 1).map(([action]) => action);
  assert.deepEqual(drifted, [], `pinned to more than one commit: ${drifted.join(', ')}`);
});
