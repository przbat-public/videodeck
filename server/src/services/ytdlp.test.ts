import { buildPlaylistArgs, getYtDlpVersion } from './ytdlp';

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
