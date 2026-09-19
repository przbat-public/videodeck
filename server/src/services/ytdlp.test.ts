import { DEFAULT_DOWNLOAD_OPTIONS } from './folderConfig';
import { buildPlaylistArgs, buildYtDlpArgs, getYtDlpVersion } from './ytdlp';

describe('buildPlaylistArgs', () => {
  it('fetches the flat playlist as NDJSON and ignores per-video errors', () => {
    expect(buildPlaylistArgs('https://www.youtube.com/@a/videos')).toEqual([
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

  it('passes harmless extraArgs through to yt-dlp', () => {
    const args = buildYtDlpArgs({
      ...job,
      options: { ...DEFAULT_DOWNLOAD_OPTIONS, extraArgs: ['--no-playlist', '--no-warnings'] },
    });

    expect(args.slice(-3)).toEqual(['--no-playlist', '--no-warnings', job.videoUrl]);
  });

  it('refuses restricted extraArgs that never went through config validation', () => {
    // The queue state file is parsed by hand, so a hand-edited
    // .queue-state.json is the one path that can still smuggle these in.
    expect(() =>
      buildYtDlpArgs({ ...job, options: { ...DEFAULT_DOWNLOAD_OPTIONS, extraArgs: ['--prox', 'http://attacker'] } }),
    ).toThrow(/restricted yt-dlp argument/);

    expect(() =>
      buildYtDlpArgs({ ...job, options: { ...DEFAULT_DOWNLOAD_OPTIONS, extraArgs: ['-o/tmp/elsewhere/x.mp4'] } }),
    ).toThrow(/restricted yt-dlp argument/);
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
