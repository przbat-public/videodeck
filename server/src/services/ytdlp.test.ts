import os from 'node:os';
import path from 'node:path';
import { DEFAULT_DOWNLOAD_OPTIONS } from './folderConfig';
import { buildPlaylistArgs, buildYtDlpArgs, getYtDlpVersion, resolveYtDlpCommand, runYtDlp } from './ytdlp';

describe('buildPlaylistArgs', () => {
  it('fetches the flat playlist as NDJSON and ignores per-video errors', () => {
    // raise_incomplete_data: on its own, yt-dlp turns "Incomplete data
    // received" on a continuation page into a warning, stops paging and exits
    // 0 with the pages it had, and list.json was replaced with the newest part
    // of the channel only
    expect(buildPlaylistArgs('https://www.youtube.com/@a/videos')).toEqual([
      '--ignore-config',
      '--flat-playlist',
      '-i',
      '-j',
      '--extractor-args',
      'youtube:raise_incomplete_data',
      'https://www.youtube.com/@a/videos',
    ]);
  });
});

describe('buildYtDlpArgs', () => {
  const job = {
    id: 'job-1',
    type: 'download' as const,
    videoUrl: 'https://www.youtube.com/watch?v=abc',
  };

  it('ignores every yt-dlp config file, wherever the process starts', () => {
    // yt-dlp reads yt-dlp.conf from the working directory, which for a
    // download is the channel folder: anyone who can write a file there
    // (network share, NAS) would otherwise get an --exec hook.
    expect(buildYtDlpArgs(job)[0]).toBe('--ignore-config');
    expect(buildYtDlpArgs({ ...job, type: 'update', baseName: '20260101_x' })[0]).toBe('--ignore-config');
    expect(buildPlaylistArgs('https://www.youtube.com/@a')).toContain('--ignore-config');
  });

  it('passes allowlisted extraArgs through to yt-dlp', () => {
    const args = buildYtDlpArgs({
      ...job,
      options: { ...DEFAULT_DOWNLOAD_OPTIONS, extraArgs: ['--no-playlist', '--no-warnings'] },
    });

    expect(args.slice(-3)).toEqual(['--no-playlist', '--no-warnings', job.videoUrl]);
  });

  it('refuses extraArgs that never went through config validation', () => {
    // The queue state file is parsed by hand, so a hand-edited
    // .queue-state.json is the one path that can still smuggle these in.
    const refused = [
      ['--exec', 'id'],
      ['--alias', 'foo', '--exec {0}', '--foo', 'touch /tmp/pwned'],
      ['--prox', 'http://attacker'],
      ['-ia', '/tmp/urls.txt'],
      ['-o/tmp/elsewhere/x.mp4'],
      ['http://169.254.169.254/latest/meta-data/'],
    ];
    for (const extraArgs of refused) {
      expect(() => buildYtDlpArgs({ ...job, options: { ...DEFAULT_DOWNLOAD_OPTIONS, extraArgs } })).toThrow(
        /refusing yt-dlp argument/,
      );
    }
  });

  it('refuses a baseName that could leave the folder', () => {
    // The last line before spawn: whatever produced the stem (the folder index,
    // the queue state file, a caller added tomorrow), yt-dlp never receives a
    // `-o` template that points somewhere else.
    const refused = ['../../etc/passwd', 'sub/dir', 'sub\\dir', '..', '', 'a\u0000b', 'x'.repeat(201)];
    for (const baseName of refused) {
      expect(() => buildYtDlpArgs({ ...job, type: 'update', baseName })).toThrow(/baseName/);
    }
    // A download job ignores the field, but a caller that set one has it
    // checked rather than silently dropped.
    expect(() => buildYtDlpArgs({ ...job, baseName: '../x' })).toThrow(/baseName/);
    expect(buildYtDlpArgs({ ...job, type: 'update', baseName: '20260101_Ok [abc]' })).toContain(
      '.videodeck-staging/job-1/20260101_Ok [abc].%(ext)s',
    );
  });

  it('refuses a stem yt-dlp would read as an environment variable', () => {
    // yt-dlp expands environment variables in -o before it fills in the
    // fields, and `$$` is no escape on POSIX, so `$API_TOKEN.%(ext)s` would
    // name the file after the token. App downloads pass --restrict-filenames,
    // which drops `$`; only a file named by hand reaches this check.
    for (const baseName of ['$HOME', `\${TMPDIR}x`, '$API_TOKEN', 'Price $5']) {
      expect(() => buildYtDlpArgs({ ...job, type: 'update', baseName })).toThrow(/baseName/);
      expect(() => buildYtDlpArgs({ ...job, type: 'repair', baseName })).toThrow(/baseName/);
    }
  });

  it('never starts the -o of an in-place repair with the stem, where yt-dlp reads TYPES:', () => {
    // yt-dlp takes `-o TYPES:TEMPLATE` when the value starts with output type
    // names and a colon (checked against its parseOpts): a file named
    // `Description:My talk` set the description's template and left the run
    // without a default one. Python's case folding also takes `ſubtitle:` and
    // `linK:` with a Kelvin sign, so no list of names covers it, while a value
    // that starts with `./` is always the default template.
    for (const baseName of ['Description:My talk', 'infojson,thumbnail:x', 'ſubtitle:x', 'lin\u212a:x']) {
      const args = buildYtDlpArgs({ ...job, type: 'repair', baseName });
      expect(args[args.indexOf('-o') + 1]).toBe(`./${baseName}.%(ext)s`);
    }
  });

  it('fetches only sidecars for a repair job, and never consults the archive', () => {
    // A repair exists because something is missing, so the archive must not
    // decide that the video is done: `--download-archive` is what makes yt-dlp
    // skip a video whose subtitles never arrived.
    const args = buildYtDlpArgs({
      ...job,
      type: 'repair',
      baseName: '20260101_A_Video',
      options: { ...DEFAULT_DOWNLOAD_OPTIONS, subLangs: ['pl', 'en'] },
    });

    expect(args).toContain('--skip-download');
    expect(args).toContain('--write-subs');
    expect(args).toContain('--write-auto-subs');
    expect(args[args.indexOf('--sub-lang') + 1]).toBe('pl,en');
    expect(args[args.indexOf('-o') + 1]).toBe('./20260101_A_Video.%(ext)s');
    expect(args.some((arg) => arg.includes('archive'))).toBe(false);
    expect(args).not.toContain('-f');
    expect(args).not.toContain('--merge-output-format');
  });

  it('keeps every file already on disk for a sidecar repair', () => {
    // yt-dlp rewrites the info.json, and deletes a subtitle or a thumbnail
    // before fetching it again, unless told not to overwrite. A sidecar repair
    // writes no comment section, so overwriting replaced the archived comments
    // with none, and a 429 on a subtitle it re-fetched left that one gone.
    const sidecars = buildYtDlpArgs({
      ...job,
      type: 'repair',
      baseName: '20260101_A_Video',
      writeComments: false,
    });

    expect(sidecars).not.toContain('--write-comments');
    expect(sidecars).toContain('--no-overwrites');
  });

  it('refreshes the comment section when the repair asks for it', () => {
    // --no-overwrites would keep the old info.json and throw the fresh
    // comment list away, which is the whole job of this repair
    const withComments = buildYtDlpArgs({
      ...job,
      type: 'repair',
      baseName: '20260101_A_Video',
      writeComments: true,
    });

    expect(withComments).toContain('--write-comments');
    expect(withComments).not.toContain('--no-overwrites');
    // Into its staging directory instead: refreshStaging merges the fresh
    // comment list with the archived one
    expect(withComments[withComments.indexOf('-o') + 1]).toBe('.videodeck-staging/job-1/20260101_A_Video.%(ext)s');
  });

  it('writes an update into its staging directory and a sidecar repair in place', () => {
    const updateArgs = buildYtDlpArgs({ ...job, type: 'update', baseName: '20260101_A_Video' });
    const sidecars = buildYtDlpArgs({ ...job, type: 'repair', baseName: '20260101_A_Video' });

    expect(updateArgs[updateArgs.indexOf('-o') + 1]).toBe('.videodeck-staging/job-1/20260101_A_Video.%(ext)s');
    expect(sidecars[sidecars.indexOf('-o') + 1]).toBe('./20260101_A_Video.%(ext)s');
  });

  it('refuses a staged run without a plain job id', () => {
    // The id becomes a directory name inside the channel folder
    for (const id of [undefined, '../x', 'a/b', '']) {
      expect(() => buildYtDlpArgs({ ...job, id, type: 'update', baseName: '20260101_A_Video' })).toThrow(/job id/);
    }
  });

  it('still validates the output stem of a repair job', () => {
    expect(() => buildYtDlpArgs({ ...job, type: 'repair', baseName: '../x' })).toThrow(/baseName/);
  });
});

describe('runYtDlp', () => {
  it('rejects a run whose stdout passes the cap, so a cut listing never reads as complete', async () => {
    // A flat playlist of a very large channel can pass the cap; resolving with
    // the part that fit replaced list.json with the newest videos only. Node
    // stands in for yt-dlp: about 80 MiB of NDJSON, then a clean exit.
    const script =
      'const line = \'{"id":"x"}\\n\'.repeat(1024 * 1024); for (let i = 0; i < 7; i += 1) process.stdout.write(line);';

    const failure = await runYtDlp(['-e', script], os.tmpdir(), { command: process.execPath }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(Error);
    expect(failure instanceof Error ? failure.message : '').toMatch(/output passed 64 MiB/);
  });

  it('keeps only the tail of a long stderr in the failure message', async () => {
    // yt-dlp prints the ERROR line that explains a failure last, after any
    // warnings. Node stands in for yt-dlp and writes 4 MB of warnings first.
    const script = [
      "process.stderr.write('HEAD-MARKER\\n' + 'WARNING: filler\\n'.repeat(250000) + 'ERROR: TAIL-MARKER\\n');",
      'process.exitCode = 1;',
    ].join('');

    const failure = await runYtDlp(['-e', script], os.tmpdir(), { command: process.execPath }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(Error);
    const message = failure instanceof Error ? failure.message : '';
    expect(message).toMatch(/exited with code 1: /);
    // Numbers and booleans, so a failing run does not print 4 MB
    expect(Buffer.byteLength(message)).toBeLessThan(128 * 1024);
    expect(message.includes('HEAD-MARKER')).toBe(false);
    expect(message.endsWith('ERROR: TAIL-MARKER')).toBe(true);
    // The cap keeps the last 13 bytes of a line; the message starts at the next one
    expect(message).toMatch(/exited with code 1: WARNING: filler\n/);
  });

  it('keeps the cut text when the last line alone passes the stderr cap', async () => {
    // Dropping to the first full line left nothing when the only newline in the
    // kept 64 KiB was the last byte, and the message ended at the colon
    const script = "process.stderr.write('x'.repeat(100 * 1024) + ' ERROR: LONG-LINE\\n'); process.exitCode = 1;";

    const failure = await runYtDlp(['-e', script], os.tmpdir(), { command: process.execPath }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure instanceof Error ? failure.message : '').toMatch(/exited with code 1: x+ ERROR: LONG-LINE$/);
  });
});

/** The fake binary the deep tests run, as an absolute path */
const FAKE_YTDLP = path.join(__dirname, '../../../scripts/fake-bin/yt-dlp');

/**
 * Run `body` with YTDLP_PATH set to `value`. process.env outlives a test file
 * inside a vitest worker, so the value goes back the way this file found it:
 * the next file would inherit the fake binary otherwise.
 */
async function withYtDlpPath(value: string, body: () => Promise<void>): Promise<void> {
  const original = process.env.YTDLP_PATH;
  process.env.YTDLP_PATH = value;
  try {
    await body();
  } finally {
    if (original === undefined) {
      delete process.env.YTDLP_PATH;
    } else {
      process.env.YTDLP_PATH = original;
    }
  }
}

describe('getYtDlpVersion', () => {
  it('returns the version of a real executable', async () => {
    // node always exists in the test environment and prints "v22.x.y" for
    // --version — good enough to exercise the spawn + stdout plumbing.
    const version = await getYtDlpVersion('node');

    expect(version).toMatch(/^v?\d+\.\d+\.\d+/);
  });

  it('returns null when the command does not exist', async () => {
    await expect(getYtDlpVersion('definitely-not-a-command-xyz')).resolves.toBeNull();
  });

  it('asks the binary YTDLP_PATH names when no command is given', async () => {
    // The queue spawns YTDLP_PATH (downloadQueue/queue.ts), so the version in
    // the boot log has to come from that binary and not from the one on PATH.
    await withYtDlpPath(FAKE_YTDLP, async () => {
      await expect(getYtDlpVersion()).resolves.toBe('2026.06.01-fake');
    });
  });
});

describe('a relative YTDLP_PATH', () => {
  // spawn resolves a command with a slash against the child's working
  // directory. The boot check runs in the server's own, while a queue job and
  // the playlist fetch run in the channel folder, so the boot could report a
  // version while every job failed with ENOENT.
  const relative = path.relative(process.cwd(), FAKE_YTDLP);

  it('runs the same binary whatever folder the run starts in', async () => {
    await withYtDlpPath(relative, async () => {
      expect((await runYtDlp(['--version'], os.tmpdir())).trim()).toBe('2026.06.01-fake');
    });
  });

  it('reaches the download queue resolved the same way', async () => {
    await withYtDlpPath(relative, async () => {
      // The queue reads YTDLP_PATH once, when its module loads
      vi.resetModules();
      const queue = await import('./downloadQueue/queue.js');

      expect(queue.YTDLP_PATH).toBe(FAKE_YTDLP);
    });
  });
});

describe('resolveYtDlpCommand', () => {
  it('leaves PATH to find yt-dlp, or a bare name YTDLP_PATH gives', () => {
    expect(resolveYtDlpCommand({})).toBe('yt-dlp');
    expect(resolveYtDlpCommand({ YTDLP_PATH: 'yt-dlp-nightly' })).toBe('yt-dlp-nightly');
  });

  it('passes an empty value on as it is', () => {
    // spawn refuses an empty command, so every job fails at its start and the
    // boot warns, as it did before relative values were resolved
    expect(resolveYtDlpCommand({ YTDLP_PATH: '' })).toBe('');
  });
});
