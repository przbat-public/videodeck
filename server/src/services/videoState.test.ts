import type { FolderIndexEntry } from './folderIndex';
import type { VideoStateInput, WantedSidecars } from './videoState';
import {
  DEFAULT_WANTED_SIDECARS,
  missingSidecars,
  needsDownload,
  needsRepair,
  videoDownloadState,
  wantedSidecars,
} from './videoState';

/** An index entry as the folder index writes one, with `pl` subtitles missing */
function entry(overrides: Partial<FolderIndexEntry> = {}): FolderIndexEntry {
  return {
    baseName: '20240101_A_Video',
    videoFile: '20240101_A_Video.mp4',
    infoMtime: '2024-01-01T00:00:00.000Z',
    subtitleLangs: ['en'],
    hasComments: true,
    hasDescription: true,
    hasThumbnail: true,
    videoBytes: 1024,
    infoBytes: 4096,
    ...overrides,
  };
}

function input(overrides: Partial<VideoStateInput> = {}): VideoStateInput {
  return { entry: entry(), inArchive: true, ...overrides };
}

/** The default wants, plus Polish subtitles, which is the case on this disk */
const wantsPl: WantedSidecars = { ...DEFAULT_WANTED_SIDECARS, subLangs: ['pl', 'en'] };

describe('wantedSidecars', () => {
  it('falls back to the server defaults for a folder without a config', () => {
    expect(wantedSidecars(null)).toEqual(DEFAULT_WANTED_SIDECARS);
  });

  it('reads the subtitle languages and the comment flag from the config', () => {
    expect(wantedSidecars({ subLangs: ['pl', 'en'], writeComments: false })).toEqual({
      subLangs: ['pl', 'en'],
      comments: false,
      description: true,
      thumbnail: true,
    });
  });

  it('stops wanting a sidecar an extraArg switches off', () => {
    // A folder that passes --no-write-thumbnail is not incomplete without one.
    expect(wantedSidecars({ extraArgs: ['--no-write-thumbnail', '--no-write-description'] })).toMatchObject({
      description: false,
      thumbnail: false,
    });
  });

  it('treats an empty subtitle list as "no subtitles wanted", not as a default', () => {
    expect(wantedSidecars({ subLangs: [] }).subLangs).toEqual([]);
  });
});

describe('videoDownloadState', () => {
  it('reports the files a complete video has', () => {
    const state = videoDownloadState(input(), wantsPl);

    expect(state.files).toEqual({
      video: true,
      thumbnail: true,
      description: true,
      subLangs: ['en'],
      comments: true,
      videoBytes: 1024,
      infoBytes: 4096,
    });
  });

  it('names the Polish subtitles a video is missing', () => {
    // The case this whole feature exists for: a channel whose videos have
    // English subtitles and no Polish ones, with nothing that used to say so.
    expect(videoDownloadState(input(), wantsPl).missing).toEqual(['pl']);
  });

  it('names every sidecar a bare download is missing', () => {
    const state = videoDownloadState(
      input({ entry: entry({ subtitleLangs: [], hasComments: false, hasDescription: false, hasThumbnail: false }) }),
      wantsPl,
    );

    expect(state.missing).toEqual(['thumbnail', 'description', 'comments', 'pl', 'en']);
  });

  it('reports nothing missing for a video that is not downloaded at all', () => {
    // `files: null` is the answer; listing every artifact would fill the console
    // with rows that only mean "not downloaded".
    const state = videoDownloadState(input({ entry: null, inArchive: false }), wantsPl);

    expect(state.files).toBeNull();
    expect(state.missing).toEqual([]);
  });

  it('flags a video the archive claims to hold while the disk does not', () => {
    // The drift A3/B4 look for: files deleted from the folder, entry left in
    // archive.txt, so plain yt-dlp would skip the video forever.
    const state = videoDownloadState(input({ entry: null, inArchive: true }), wantsPl);

    expect(state.archive).toEqual({ onDisk: false, inArchive: true, drift: true });
  });

  it('flags a video on disk that the archive has never seen', () => {
    const state = videoDownloadState(input({ inArchive: false }), wantsPl);

    expect(state.archive).toEqual({ onDisk: true, inArchive: false, drift: true });
  });

  it('reports no drift when both sides agree', () => {
    expect(videoDownloadState(input(), wantsPl).archive.drift).toBe(false);
    expect(videoDownloadState(input({ entry: null, inArchive: false }), wantsPl).archive.drift).toBe(false);
  });
});

describe('missingSidecars', () => {
  it('does not ask for a sidecar the folder never wanted', () => {
    const bare = videoDownloadState(input({ entry: entry({ subtitleLangs: [], hasComments: false }) }), {
      subLangs: [],
      comments: false,
      description: true,
      thumbnail: true,
    });
    expect(bare.missing).toEqual([]);
  });

  it('asks for one language when only that one is configured', () => {
    const state = videoDownloadState(input(), { ...DEFAULT_WANTED_SIDECARS, subLangs: ['en'] });
    expect(missingSidecars(state, { ...DEFAULT_WANTED_SIDECARS, subLangs: ['en'] })).toEqual([]);
  });
});

describe('needsDownload / needsRepair', () => {
  it('asks for a download only when nothing of the video is on disk', () => {
    expect(needsDownload(null)).toBe(true);
    expect(needsDownload(entry())).toBe(false);
  });

  it('asks for a repair only for a video that has something missing', () => {
    expect(needsRepair(videoDownloadState(input(), wantsPl))).toBe(true);
    expect(needsRepair(videoDownloadState(input(), DEFAULT_WANTED_SIDECARS))).toBe(false);
    // A video that is not downloaded is not a repair candidate
    expect(needsRepair(videoDownloadState(input({ entry: null, inArchive: false }), wantsPl))).toBe(false);
  });
});
