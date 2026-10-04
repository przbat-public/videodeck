import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { at } from '../test-utils';
import { ListJsonError, readListJson, toCatalogEntry, trimPlaylistEntries } from './channelList';

/**
 * A raw entry as `yt-dlp --flat-playlist -j` writes it: the fields this app
 * keeps, plus the playlist bookkeeping that used to be stored verbatim. The
 * keys and their shapes come from a real dump.
 */
const RAW_ENTRY = {
  _type: 'url',
  _version: { version: '2026.08.19' },
  ie_key: 'Youtube',
  id: 'O4KKivS5btY',
  title: 'Sewing studio haul from Łódź - Polimex',
  url: 'https://www.youtube.com/watch?v=O4KKivS5btY',
  duration: 852,
  view_count: 1300,
  availability: null,
  live_status: null,
  timestamp: null,
  release_year: null,
  channel_url: 'https://www.youtube.com/channel/UCtest',
  playlist_index: 7,
  playlist_id: 'UUtestsuffix',
  playlist_title: 'Sewing',
  playlist_autonumber: 7,
  n_entries: 4200,
  __last_playlist_index: 4200,
  __x_forwarded_for_ip: '203.0.113.7',
  thumbnails: [{ url: 'https://i.ytimg.com/vi/O4KKivS5btY/hq.jpg', width: 480, height: 360 }],
  webpage_url: 'https://www.youtube.com/watch?v=O4KKivS5btY',
  webpage_url_basename: 'watch',
  extractor: 'youtube',
  extractor_key: 'Youtube',
};

describe('trimPlaylistEntries', () => {
  it('keeps the fields the app reads and drops the playlist bookkeeping', () => {
    const [video] = trimPlaylistEntries([RAW_ENTRY]);

    expect(video).toEqual({
      id: 'O4KKivS5btY',
      title: 'Sewing studio haul from Łódź - Polimex',
      url: 'https://www.youtube.com/watch?v=O4KKivS5btY',
      duration: 852,
      viewCount: 1300,
    });
  });

  it('reads the upload date off the id, which is where yt-dlp put it', () => {
    // A flat-playlist dump carries no upload date, so the state panel has no
    // other source. The app's own file names start with it.
    const [video] = trimPlaylistEntries([{ id: '20240403_Pruning_Willow_Arches', title: 'x' }]);

    expect(video?.uploadDate).toBe('20240403');
  });

  it('keeps an availability that says something and ignores a null', () => {
    const kept = trimPlaylistEntries([{ ...RAW_ENTRY, availability: 'needs_auth' }]);
    const dropped = trimPlaylistEntries([RAW_ENTRY]);

    expect(at(kept, 0).availability).toBe('needs_auth');
    expect(at(dropped, 0).availability).toBeUndefined();
  });

  it('drops an entry without an id instead of writing a row nobody can match', () => {
    // Every consumer matches a video by id, so an entry without one cannot be
    // listed, downloaded or repaired.
    const videos = trimPlaylistEntries([{ title: 'No id' }, RAW_ENTRY, null, 'not an object']);

    expect(videos.map((video) => video.id)).toEqual(['O4KKivS5btY']);
  });

  it('falls back to webpage_url for an entry that has no url', () => {
    const [video] = trimPlaylistEntries([{ id: 'aaaaaaaaaaa', title: 'x', webpage_url: 'https://youtu.be/a' }]);

    expect(video?.url).toBe('https://youtu.be/a');
  });
});

describe('toCatalogEntry', () => {
  it('writes the kept keys in a fixed order and nothing else', () => {
    const entry = toCatalogEntry({
      id: 'aaaaaaaaaaa',
      title: 'A video',
      url: 'https://youtu.be/a',
      duration: 42,
      viewCount: 7,
      uploadDate: '20260101',
      availability: 'needs_auth',
    });

    // The order is part of the contract: two fetches of the same channel have
    // to produce the same file, or the diff of list.json is noise.
    expect(Object.keys(entry)).toEqual(['id', 'title', 'url', 'duration', 'viewCount', 'availability']);
    expect(entry.uploadDate).toBeUndefined();
  });

  it('omits the optional keys an entry does not have', () => {
    expect(Object.keys(toCatalogEntry({ id: 'a', title: 't', url: 'u' }))).toEqual(['id', 'title', 'url']);
  });
});

describe('readListJson', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'channel-list-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('reads a catalog file the app wrote', async () => {
    await fs.writeFile(
      path.join(dir, 'list.json'),
      JSON.stringify([toCatalogEntry({ id: 'aaaaaaaaaaa', title: 'A video', url: 'https://youtu.be/a' })]),
      'utf-8',
    );

    expect(await readListJson(dir)).toEqual([
      expect.objectContaining({ id: 'aaaaaaaaaaa', title: 'A video', url: 'https://youtu.be/a' }),
    ]);
  });

  it('still reads a raw dump written before the catalog shape existed', async () => {
    await fs.writeFile(path.join(dir, 'list.json'), JSON.stringify([RAW_ENTRY]), 'utf-8');

    const videos = await readListJson(dir);

    expect(at(videos ?? [], 0)).toMatchObject({ id: 'O4KKivS5btY', duration: 852, viewCount: 1300 });
  });

  it('answers null for a folder without a list', async () => {
    expect(await readListJson(dir)).toBeNull();
  });

  it('refuses a file that is not an array', async () => {
    await fs.writeFile(path.join(dir, 'list.json'), '{"nope":true}', 'utf-8');

    await expect(readListJson(dir)).rejects.toBeInstanceOf(ListJsonError);
  });
});
