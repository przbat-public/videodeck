import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// The fake binary validates the yt-dlp argument templates without network
// access; the CI integration job puts scripts/fake-bin on PATH.
const fakeYtDlp = fileURLToPath(new URL('./fake-bin/yt-dlp', import.meta.url));

/**
 * @param {string[]} args
 */
const run = (...args) => spawnSync(fakeYtDlp, args, { encoding: 'utf-8' });

test('answers --version for the boot-time probe', () => {
  const result = run('--version');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^20\d\d\.\d\d\.\d\d-fake/);
});

test('accepts a simulated download of a canonical watch URL', () => {
  const result = run('--simulate', '-f', 'best', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(result.status, 0);
});

test('rejects every cookie-exfiltration flag', () => {
  for (const flag of ['--cookies', '--load-cookies', '--cookies-from-browser', '--netrc-cmd']) {
    const result = run(flag, 'x', '--simulate', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    assert.equal(result.status, 2, `${flag} must be rejected`);
    assert.match(result.stderr, new RegExp(flag));
  }
});

test('rejects runs without --simulate (a test would really download)', () => {
  const result = run('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(result.status, 2);
});

test('rejects non-watch URLs', () => {
  const result = run('--simulate', 'https://www.youtube.com/playlist?list=PLx');
  assert.equal(result.status, 2);
});
