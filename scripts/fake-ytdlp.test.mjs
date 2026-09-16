import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// The fake binary doubles as a validation gate for the yt-dlp argument
// templates AND as the download backend of the deep integration tests; the
// CI integration job puts scripts/fake-bin on PATH.
const fakeYtDlp = fileURLToPath(new URL('./fake-bin/yt-dlp', import.meta.url));

/**
 * @param {string[]} args
 */
const run = (...args) => {
  const maybeCwd = args[args.length - 1];
  const cwd = typeof maybeCwd === 'string' && maybeCwd.startsWith('/') && args.length > 1 ? args.pop() : process.cwd();
  return spawnSync(fakeYtDlp, args, { encoding: 'utf-8', cwd });
};

const WATCH_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

test('answers --version for the boot-time probe', () => {
  const result = run('--version');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^20\d\d\.\d\d\.\d\d-fake/);
});

test('accepts a simulated download of a canonical watch URL', () => {
  const result = run('--simulate', '-f', 'best', WATCH_URL);
  assert.equal(result.status, 0);
});

test('rejects every cookie-exfiltration flag', () => {
  for (const flag of ['--cookies', '--load-cookies', '--cookies-from-browser', '--netrc-cmd']) {
    const result = run(flag, 'x', '--simulate', WATCH_URL);
    assert.equal(result.status, 2, `${flag} must be rejected`);
    assert.match(result.stderr, new RegExp(flag));
  }
});

test('rejects a run without a canonical watch URL', () => {
  const result = run('https://www.youtube.com/playlist?list=PLx');
  assert.equal(result.status, 2);
});

test('prints NDJSON playlist entries for --flat-playlist -j', () => {
  const result = run('--flat-playlist', '-i', '-j', 'https://www.youtube.com/@somechannel');
  assert.equal(result.status, 0);
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines.length, 2);
  for (const line of lines) {
    const entry = JSON.parse(line);
    assert.equal(typeof entry.id, 'string');
    assert.match(entry.url, /^https:\/\/www\.youtube\.com\/watch\?v=/);
  }
});

test('a download writes the video, sidecars, progress lines and archive entry', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fake-ytdlp-'));
  try {
    const result = run(
      '-o',
      '%(upload_date)s_%(title)s.%(ext)s',
      '--write-thumbnail',
      '--write-description',
      '--write-info-json',
      '--write-subs',
      '--sub-lang',
      'en',
      '--download-archive',
      'archive.txt',
      WATCH_URL,
      dir,
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^download {2}\d+%/m);
    // The deep environment's videoFiles() helper (test-infra) promises these
    // exact names and contents; the fake and that promise stay in lockstep.
    const base = path.join(dir, '20260101_Fake video dQw4w9WgXcQ');
    assert.equal(readFileSync(`${base}.mp4`, 'utf-8'), 'fake-mp4-bytes');
    assert.equal(readFileSync(`${base}.webp`, 'utf-8'), 'fake-webp');
    assert.equal(
      readFileSync(`${base}.en.vtt`, 'utf-8'),
      'WEBVTT\n\n00:00.000 --> 00:01.000\nDeep test subtitle line.\n',
    );
    assert.deepEqual(JSON.parse(readFileSync(`${base}.info.json`, 'utf-8')), {
      id: 'dQw4w9WgXcQ',
      title: 'Fake video dQw4w9WgXcQ',
      upload_date: '20260101',
      duration: 42,
      view_count: 1234,
      like_count: 56,
      channel: 'Deep test channel',
      description: 'Deep test description.',
      webpage_url: WATCH_URL,
    });
    assert.match(readFileSync(path.join(dir, 'archive.txt'), 'utf-8'), /youtube dQw4w9WgXcQ/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a recorded archive entry skips the download (silent success)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fake-ytdlp-'));
  try {
    const args = ['-o', '%(upload_date)s_%(title)s.%(ext)s', '--download-archive', 'archive.txt', WATCH_URL, dir];
    assert.equal(run(...args).status, 0);
    const second = run(...args);
    assert.equal(second.status, 0);
    assert.match(second.stdout, /already been recorded in the archive/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('prints the members-only error and exits 1 for a member video', () => {
  const result = run('--simulate', 'https://www.youtube.com/watch?v=member123');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /members/i);
});

test('prefixes permanent failures with the youtube extractor id, like the live binary', () => {
  // Grounded in live yt-dlp 2026.08: `ERROR: [youtube] <id>: <reason>`.
  const member = run('--simulate', 'https://www.youtube.com/watch?v=member123');
  assert.match(member.stderr, /^ERROR: \[youtube\] member123: This video is available/);
  const privateVideo = run('--simulate', 'https://www.youtube.com/watch?v=private123');
  assert.equal(privateVideo.status, 1);
  assert.match(privateVideo.stderr, /^ERROR: \[youtube\] private123: Private video\. Sign in/);
  const removed = run('--simulate', 'https://www.youtube.com/watch?v=removed123');
  assert.equal(removed.status, 1);
  assert.match(removed.stderr, /^ERROR: \[youtube\] removed123: Video unavailable\. This video has been removed/);
});
