import { DEFAULT_DOWNLOAD_OPTIONS } from './folderConfig';
import { buildPlaylistArgs, buildYtDlpArgs, getYtDlpVersion } from './ytdlp';

describe('buildPlaylistArgs', () => {
  it('fetches the flat playlist as NDJSON and ignores per-video errors', () => {
    expect(buildPlaylistArgs('https://www.youtube.com/@a/videos')).toEqual([
      '--ignore-config',
      '--flat-playlist',
      '-i',
      '-j',
      'https://www.youtube.com/@a/videos',
    ]);
  });
});

describe('buildYtDlpArgs', () => {
  const job = {
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
      '20260101_Ok [abc].%(ext)s',
    );
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
    expect(args[args.indexOf('-o') + 1]).toBe('20260101_A_Video.%(ext)s');
    expect(args.some((arg) => arg.includes('archive'))).toBe(false);
    expect(args).not.toContain('-f');
    expect(args).not.toContain('--merge-output-format');
  });

  it('leaves comments alone for a sidecar repair and writes them when asked', () => {
    const sidecars = buildYtDlpArgs({
      ...job,
      type: 'repair',
      baseName: '20260101_A_Video',
      writeComments: false,
    });
    expect(sidecars).not.toContain('--write-comments');

    const withComments = buildYtDlpArgs({
      ...job,
      type: 'repair',
      baseName: '20260101_A_Video',
      writeComments: true,
    });
    expect(withComments).toContain('--write-comments');
  });

  it('still validates the output stem of a repair job', () => {
    expect(() => buildYtDlpArgs({ ...job, type: 'repair', baseName: '../x' })).toThrow(/baseName/);
  });
});

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
});
