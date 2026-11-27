import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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

/**
 * Run in `cwd` with extra environment variables: how a test opts into one of
 * the fake's simulations (FAKE_YTDLP_RATE_LIMIT_SUB_LANG, FAKE_YTDLP_COMMENTS,
 * FAKE_YTDLP_DESCRIPTION, FAKE_YTDLP_FAIL_AFTER_WRITE).
 *
 * @param {string} cwd
 * @param {string[]} args
 * @param {Record<string, string>} env
 */
const runWithEnv = (cwd, args, env) =>
  spawnSync(fakeYtDlp, args, { encoding: 'utf-8', cwd, env: { ...process.env, ...env } });

const WATCH_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

/**
 * The arguments of a `repair` job under yt-dlp's default overwrite policy
 * (server/src/services/ytdlp.ts, buildYtDlpArgs): the sidecar flags on an
 * existing stem, `--skip-download`, and deliberately no `--download-archive`
 * — the archive records videos, not the sidecars a repair went looking for.
 * A sidecar repair adds `--no-overwrites` and a comment repair
 * `--write-comments`; the tests below splice those in where they matter.
 *
 * @param {string} stem
 */
const repairArgs = (stem) => [
  '--ignore-config',
  '-i',
  '--no-playlist',
  '--newline',
  '--skip-download',
  '-o',
  `${stem}.%(ext)s`,
  '--write-thumbnail',
  '--write-description',
  '--write-info-json',
  '--write-subs',
  '--write-auto-subs',
  '--sub-lang',
  'pl,en',
  WATCH_URL,
];

/** The subtitle body every `.vtt` the fake writes carries */
const SUBTITLE_BODY = 'WEBVTT\n\n00:00.000 --> 00:01.000\nDeep test subtitle line.\n';

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

test('refuses to run when a yt-dlp.conf would be loaded from the cwd', () => {
  // Negative control for the --ignore-config guard: this is the vector the
  // real binary turns into --exec.
  const dir = mkdtempSync(path.join(tmpdir(), 'fake-ytdlp-conf-'));
  try {
    writeFileSync(path.join(dir, 'yt-dlp.conf'), "--exec 'touch pwned'\n");
    const withoutFlag = run('--simulate', WATCH_URL, dir);
    assert.equal(withoutFlag.status, 3);
    assert.match(withoutFlag.stderr, /yt-dlp\.conf would have been loaded/);

    const withFlag = run('--ignore-config', '--simulate', WATCH_URL, dir);
    assert.equal(withFlag.status, 0, withFlag.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('appends every invocation to the folder argv log when the file is there', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fake-ytdlp-argv-'));
  try {
    // Opting in is creating the file; until then the fake writes nothing.
    assert.equal(run('--version', dir).status, 0);
    assert.equal(existsSync(path.join(dir, '.fake-ytdlp-argv.jsonl')), false);

    writeFileSync(path.join(dir, '.fake-ytdlp-argv.jsonl'), '');
    assert.equal(run('--version', dir).status, 0);
    const entries = readFileSync(path.join(dir, '.fake-ytdlp-argv.jsonl'), 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0].args, ['--version']);
    // macOS tmpdir lives under /private via a symlink; compare real paths
    assert.equal(entries[0].cwd, realpathSync(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

test('reports a rate-limited subtitle language after the others are written', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fake-ytdlp-'));
  try {
    const stem = '20260101_Fake video dQw4w9WgXcQ';
    writeFileSync(path.join(dir, `${stem}.mp4`), 'fake-mp4-bytes');

    const result = runWithEnv(dir, repairArgs(stem), { FAKE_YTDLP_RATE_LIMIT_SUB_LANG: 'pl' });

    assert.equal(result.status, 0, result.stderr);
    // The language that answered is on disk and the throttled one is not, the
    // way a repair that ran into YouTube's limit leaves the folder. The run
    // itself still succeeds: the repair passes `-i`, and a subtitle the real
    // binary cannot fetch is the warning below, not a failed job.
    assert.equal(existsSync(path.join(dir, `${stem}.en.vtt`)), true);
    assert.equal(existsSync(path.join(dir, `${stem}.pl.vtt`)), false);
    // Wording mirrors the live binary, prefix included.
    assert.match(
      result.stderr,
      /WARNING: Unable to download video subtitles for 'pl': HTTP Error 429: Too Many Requests/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a repair run writes the subtitles of the languages asked and leaves the video alone', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fake-ytdlp-'));
  try {
    const stem = '20260101_Fake video dQw4w9WgXcQ';
    const videoPath = path.join(dir, `${stem}.mp4`);
    // A sentinel, not the bytes a download writes: a rewrite would show up.
    writeFileSync(videoPath, 'fake-mp4-bytes-of-a-video-already-there');
    // The id is already in the archive, and a repair passes no
    // --download-archive: the archive records videos, not the sidecars a repair
    // went looking for, so it must not make the run skip the work it was queued
    // for. The run must not append to it either — the app owns that file.
    writeFileSync(path.join(dir, 'archive.txt'), 'youtube dQw4w9WgXcQ\n');

    const result = run(...repairArgs(stem), dir);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(readFileSync(path.join(dir, `${stem}.en.vtt`), 'utf-8'), SUBTITLE_BODY);
    assert.equal(readFileSync(path.join(dir, `${stem}.pl.vtt`), 'utf-8'), SUBTITLE_BODY);
    // --skip-download: the media file of the video being repaired is untouched
    assert.equal(readFileSync(videoPath, 'utf-8'), 'fake-mp4-bytes-of-a-video-already-there');
    assert.equal(readFileSync(path.join(dir, 'archive.txt'), 'utf-8'), 'youtube dQw4w9WgXcQ\n');
    assert.equal(existsSync(path.join(dir, `${stem}.info.json`)), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

// The live binary's file policy, which is what decides whether a refresh can
// lose archived data (YoutubeDL._write_info_json and existing_file in yt-dlp
// 2026.8.19). A fake that is kinder than the binary lets a test pass on a
// server that destroys the archive.

/**
 * @param {string} dir
 * @param {string} stem
 */
const readInfo = (dir, stem) => JSON.parse(readFileSync(path.join(dir, `${stem}.info.json`), 'utf-8'));

test('writes the comment section only when the run asks for it', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fake-ytdlp-'));
  try {
    const stem = '20260101_Fake video dQw4w9WgXcQ';
    writeFileSync(path.join(dir, `${stem}.mp4`), 'fake-mp4-bytes');

    assert.equal(run(...repairArgs(stem), dir).status, 0);
    assert.equal('comments' in readInfo(dir, stem), false);

    const withComments = repairArgs(stem);
    withComments.splice(withComments.length - 1, 0, '--write-comments');
    assert.equal(run(...withComments, dir).status, 0);
    assert.ok(readInfo(dir, stem).comments.length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deletes a subtitle before fetching it again, so a refused fetch leaves it gone', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fake-ytdlp-'));
  try {
    const stem = '20260101_Fake video dQw4w9WgXcQ';
    writeFileSync(path.join(dir, `${stem}.mp4`), 'fake-mp4-bytes');
    writeFileSync(path.join(dir, `${stem}.en.vtt`), 'WEBVTT\n\narchived english\n');

    const result = runWithEnv(dir, repairArgs(stem), { FAKE_YTDLP_RATE_LIMIT_SUB_LANG: 'en' });

    // Exit 0 under -i, like the binary: the loss is a warning, not a failure
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(path.join(dir, `${stem}.en.vtt`)), false);
    assert.equal(readFileSync(path.join(dir, `${stem}.pl.vtt`), 'utf-8'), SUBTITLE_BODY);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('keeps every sidecar already on disk with --no-overwrites and fetches only the missing ones', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fake-ytdlp-'));
  try {
    const stem = '20260101_Fake video dQw4w9WgXcQ';
    const archived = {
      [`${stem}.mp4`]: 'fake-mp4-bytes',
      [`${stem}.info.json`]: JSON.stringify({ id: 'dQw4w9WgXcQ', comments: [{ id: 'kept', text: 'Archived.' }] }),
      [`${stem}.description`]: 'Archived description.',
      [`${stem}.webp`]: 'archived-webp',
      [`${stem}.en.vtt`]: 'WEBVTT\n\narchived english\n',
    };
    for (const [file, body] of Object.entries(archived)) {
      writeFileSync(path.join(dir, file), body);
    }
    const args = repairArgs(stem);
    args.splice(args.length - 1, 0, '--no-overwrites');

    const result = runWithEnv(dir, args, { FAKE_YTDLP_RATE_LIMIT_SUB_LANG: 'en' });

    assert.equal(result.status, 0, result.stderr);
    for (const [file, body] of Object.entries(archived)) {
      assert.equal(readFileSync(path.join(dir, file), 'utf-8'), body, `${file} was rewritten`);
    }
    assert.equal(readFileSync(path.join(dir, `${stem}.pl.vtt`), 'utf-8'), SUBTITLE_BODY);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// What YouTube serves today, for the staged-refresh journeys. Each knob is a
// behaviour the server is held to, so each has its own test here: a fake that
// drifted would let a journey pass or fail for the wrong reason.

/**
 * The argv of a staged run: an update or a comment repair writes under
 * `.videodeck-staging/<jobId>/` instead of next to the video.
 *
 * @param {string} stem
 * @param {string[]} extra flags spliced in before the URL
 */
const stagedArgs = (stem, extra = []) => {
  const args = repairArgs(stem);
  args[args.indexOf('-o') + 1] = `.videodeck-staging/job-1/${stem}.%(ext)s`;
  args.splice(args.length - 1, 0, ...extra);
  return args;
};

test('writes a staged run under its directory and leaves the files next to the video alone', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fake-ytdlp-'));
  try {
    const stem = '20260101_Fake video dQw4w9WgXcQ';
    writeFileSync(path.join(dir, `${stem}.en.vtt`), 'archived');

    const result = run(...stagedArgs(stem), dir);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(path.join(dir, '.videodeck-staging', 'job-1', `${stem}.info.json`)), true);
    assert.equal(readFileSync(path.join(dir, `${stem}.en.vtt`), 'utf-8'), 'archived');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writes no comment section when comments are turned off upstream', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fake-ytdlp-'));
  try {
    const stem = '20260101_Fake video dQw4w9WgXcQ';
    const result = runWithEnv(dir, stagedArgs(stem, ['--write-comments']), { FAKE_YTDLP_COMMENTS: 'disabled' });

    assert.equal(result.status, 0, result.stderr);
    const info = JSON.parse(readFileSync(path.join(dir, '.videodeck-staging', 'job-1', `${stem}.info.json`), 'utf-8'));
    assert.equal('comments' in info, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writes every file with the comments that arrived, no comment_count, then exits 1 for an interrupted extraction', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fake-ytdlp-'));
  try {
    const stem = '20260101_Fake video dQw4w9WgXcQ';
    const result = runWithEnv(dir, stagedArgs(stem, ['--write-comments']), { FAKE_YTDLP_COMMENTS: 'interrupted' });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /^ERROR: .*HTTP Error 403/m);
    const staged = path.join(dir, '.videodeck-staging', 'job-1');
    const info = JSON.parse(readFileSync(path.join(staged, `${stem}.info.json`), 'utf-8'));
    assert.ok(info.comments.length > 0);
    assert.equal('comment_count' in info, false);
    assert.equal(existsSync(path.join(staged, `${stem}.en.vtt`)), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('blanks both descriptions when the uploader blanked it', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fake-ytdlp-'));
  try {
    const stem = '20260101_Fake video dQw4w9WgXcQ';
    const result = runWithEnv(dir, stagedArgs(stem), { FAKE_YTDLP_DESCRIPTION: 'blank' });

    assert.equal(result.status, 0, result.stderr);
    const staged = path.join(dir, '.videodeck-staging', 'job-1');
    assert.equal(JSON.parse(readFileSync(path.join(staged, `${stem}.info.json`), 'utf-8')).description, '');
    assert.equal(readFileSync(path.join(staged, `${stem}.description`), 'utf-8'), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writes every file, then fails for good, when asked to fail after the write', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fake-ytdlp-'));
  try {
    const stem = '20260101_Fake video dQw4w9WgXcQ';
    const result = runWithEnv(dir, stagedArgs(stem), { FAKE_YTDLP_FAIL_AFTER_WRITE: '1' });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /^ERROR: \[youtube\] dQw4w9WgXcQ: Private video/m);
    assert.equal(existsSync(path.join(dir, '.videodeck-staging', 'job-1', `${stem}.info.json`)), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
