import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// The dependency gate walks the repository, so a generated directory that is
// not excluded becomes part of the architecture it judges. Playwright's HTML
// report is the one that bit: its trace viewer bundles ship their own module
// graph, and a spec that recorded a trace made `pnpm run lint:deps` report a
// circular dependency inside that bundle, on a machine that had just run the
// e2e suite. The list below is what "generated" means here, and each entry has
// to stay gitignored, so this cannot quietly grow to cover source.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const GENERATED_DIRS = ['dist', 'coverage', 'test-results', 'playwright-report'];

const depcruise = readFileSync(path.join(ROOT, '.dependency-cruiser.cjs'), 'utf8');
const gitignore = readFileSync(path.join(ROOT, '.gitignore'), 'utf8');

test('the dependency gate ignores every generated directory', () => {
  const exclude = /exclude:\s*\[([^\]]*)\]/.exec(depcruise)?.[1] ?? '';
  assert.notEqual(exclude, '', '.dependency-cruiser.cjs must configure an exclude list');
  const missing = GENERATED_DIRS.filter((dir) => !exclude.includes(dir));
  assert.deepEqual(missing, [], `add these to the exclude list in .dependency-cruiser.cjs: ${missing.join(', ')}`);
});

test('every directory the gate skips is generated, not source', () => {
  for (const dir of GENERATED_DIRS) {
    assert.ok(
      gitignore.includes(`${dir}/`),
      `${dir} is excluded from the dependency gate but is not gitignored: either it is source, or .gitignore is missing it`,
    );
  }
});
