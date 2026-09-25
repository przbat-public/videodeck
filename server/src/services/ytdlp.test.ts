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
