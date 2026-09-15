import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { entry } from '../test-utils';
import {
  ARCHIVE_FILE,
  extractVideoIdFromHead,
  findEntryByVideoId,
  getDownloadStatuses,
  INDEX_FILE,
  loadIndex,
  readArchiveIds,
  rebuildIndex,
  refreshIndex,
} from './folderIndex';

async function writeVideo(
  dir: string,
  baseName: string,
  id: string,
  options: { video?: boolean; ext?: string; infoPrefix?: string } = {},
): Promise<void> {
  const { video = true, ext = '.mp4', infoPrefix } = options;
  const info = { id, title: baseName, comments: [{ id: 'c1', text: 'hello' }] };
  const body = infoPrefix ?? JSON.stringify(info);
  await fs.writeFile(path.join(dir, `${baseName}.info.json`), body, 'utf-8');
  if (video) {
    await fs.writeFile(path.join(dir, `${baseName}${ext}`), 'video-bytes', 'utf-8');
  }
}

describe('folderIndex', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'folder-index-'));
    jest.spyOn(console, 'error').mockImplementation(() => {
      /* silence expected error logs */
    });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });

  describe('extractVideoIdFromHead', () => {
    it('reads the top-level id from the beginning of a yt-dlp info.json', () => {
      expect(extractVideoIdFromHead('{"id": "abc123XYZ-_", "title": "x"}')).toBe('abc123XYZ-_');
      expect(extractVideoIdFromHead('  {\n  "id":"q1w2e3r4t5y",\n"formats": []')).toBe('q1w2e3r4t5y');
    });

    it('returns null when id is not the first key', () => {
      expect(extractVideoIdFromHead('{"title": "x", "id": "abc"}')).toBeNull();
      expect(extractVideoIdFromHead('not json')).toBeNull();
    });
  });

  describe('rebuildIndex', () => {
    it('indexes only info.json files that have a matching video file', async () => {
      await writeVideo(dir, '20240101_First', 'id-first');
      await writeVideo(dir, '20240102_Second', 'id-second', { ext: '.mkv' });
      await writeVideo(dir, '20240103_NoVideo', 'id-novideo', { video: false });
      await fs.writeFile(path.join(dir, 'config.json'), '{}', 'utf-8');

      const index = await rebuildIndex(dir);

      expect(Object.keys(index.entries).sort()).toEqual(['id-first', 'id-second']);
      expect(index.entries['id-first']).toMatchObject({
        baseName: '20240101_First',
        videoFile: '20240101_First.mp4',
      });
      expect(entry(index.entries, 'id-second').videoFile).toBe('20240102_Second.mkv');
      expect(new Date(entry(index.entries, 'id-first').infoMtime).getTime()).not.toBeNaN();
    });

    it('writes the index file and archive.txt reflecting disk state', async () => {
      await writeVideo(dir, '20240101_First', 'id-first');
      await fs.writeFile(path.join(dir, ARCHIVE_FILE), 'youtube stale-id\n', 'utf-8');

      await rebuildIndex(dir);

      const saved = JSON.parse(await fs.readFile(path.join(dir, INDEX_FILE), 'utf-8'));
      expect(saved.version).toBe(1);
      expect(Object.keys(saved.entries)).toEqual(['id-first']);

      const archive = await fs.readFile(path.join(dir, ARCHIVE_FILE), 'utf-8');
      expect(archive).toBe('youtube id-first\n');
    });

    it('falls back to a full JSON parse when id is not the first key', async () => {
      await writeVideo(dir, '20240101_Reordered', 'id-reordered', {
        infoPrefix: JSON.stringify({ title: 't', id: 'id-reordered' }),
      });

      const index = await rebuildIndex(dir);

      expect(Object.keys(index.entries)).toEqual(['id-reordered']);
    });

    it('skips unreadable info.json files without failing', async () => {
      await writeVideo(dir, '20240101_Good', 'id-good');
      await writeVideo(dir, '20240102_Broken', 'ignored', { infoPrefix: '{not json' });

      const index = await rebuildIndex(dir);

      expect(Object.keys(index.entries)).toEqual(['id-good']);
    });

    it('ignores hidden files', async () => {
      await writeVideo(dir, '.hidden', 'id-hidden');
      await writeVideo(dir, '20240101_Visible', 'id-visible');

      const index = await rebuildIndex(dir);

      expect(Object.keys(index.entries)).toEqual(['id-visible']);
    });
  });

  describe('loadIndex', () => {
    it('rebuilds when the index file is missing', async () => {
      await writeVideo(dir, '20240101_First', 'id-first');

      const index = await loadIndex(dir);

      expect(Object.keys(index.entries)).toEqual(['id-first']);
      await expect(fs.access(path.join(dir, INDEX_FILE))).resolves.toBeUndefined();
    });

    it('returns the stored index without rescanning when present', async () => {
      await writeVideo(dir, '20240101_First', 'id-first');
      await rebuildIndex(dir);
      // add a file after the index was built — must not be picked up
      await writeVideo(dir, '20240102_Later', 'id-later');

      const index = await loadIndex(dir);

      expect(Object.keys(index.entries)).toEqual(['id-first']);
    });

    it('rebuilds when the index file is corrupt', async () => {
      await writeVideo(dir, '20240101_First', 'id-first');
      await fs.writeFile(path.join(dir, INDEX_FILE), '{oops', 'utf-8');

      const index = await loadIndex(dir);

      expect(Object.keys(index.entries)).toEqual(['id-first']);
    });
  });

  describe('refreshIndex', () => {
    it('adds only info.json files modified since the given time', async () => {
      await writeVideo(dir, '20240101_Old', 'id-old');
      await rebuildIndex(dir);
      // make the old file clearly older than the threshold
      const past = new Date(Date.now() - 60_000);
      await fs.utimes(path.join(dir, '20240101_Old.info.json'), past, past);

      const since = Date.now();
      await writeVideo(dir, '20240102_New', 'id-new');

      const result = await refreshIndex(dir, since);

      expect(result.changed).toEqual(['id-new']);
      expect(Object.keys(result.index.entries).sort()).toEqual(['id-new', 'id-old']);
      expect(await readArchiveIds(dir)).toEqual(new Set(['id-old', 'id-new']));
    });

    it('updates infoMtime for an existing entry that was re-written', async () => {
      await writeVideo(dir, '20240101_Video', 'id-video');
      const before = await rebuildIndex(dir);
      const past = new Date(Date.now() - 60_000);
      await fs.utimes(path.join(dir, '20240101_Video.info.json'), past, past);
      const stale = entry((await loadIndex(dir)).entries, 'id-video').infoMtime;
      expect(stale).toBe(entry(before.entries, 'id-video').infoMtime);

      const since = Date.now();
      await fs.writeFile(
        path.join(dir, '20240101_Video.info.json'),
        JSON.stringify({ id: 'id-video', title: 'renamed' }),
        'utf-8',
      );

      const result = await refreshIndex(dir, since);

      expect(result.changed).toEqual(['id-video']);
      expect(new Date(entry(result.index.entries, 'id-video').infoMtime).getTime()).toBeGreaterThan(past.getTime());
    });

    it('does not index a fresh info.json whose video file is missing', async () => {
      await writeVideo(dir, '20240101_Old', 'id-old');
      await rebuildIndex(dir);
      const past = new Date(Date.now() - 60_000);
      await fs.utimes(path.join(dir, '20240101_Old.info.json'), past, past);
      const since = Date.now();
      await writeVideo(dir, '20240102_MetaOnly', 'id-meta', { video: false });

      const result = await refreshIndex(dir, since);

      expect(result.changed).toEqual([]);
    });

    it('performs a full rebuild when no index exists yet', async () => {
      await writeVideo(dir, '20240101_First', 'id-first');

      const result = await refreshIndex(dir, Date.now() + 100_000);

      expect(result.changed).toEqual(['id-first']);
    });

    it('appends to an existing archive.txt without duplicating ids', async () => {
      await writeVideo(dir, '20240101_Old', 'id-old');
      await rebuildIndex(dir);
      // simulate yt-dlp having already appended the new id
      await fs.appendFile(path.join(dir, ARCHIVE_FILE), 'youtube id-new\n', 'utf-8');
      const since = Date.now();
      await writeVideo(dir, '20240102_New', 'id-new');

      await refreshIndex(dir, since);

      const archive = await fs.readFile(path.join(dir, ARCHIVE_FILE), 'utf-8');
      expect(archive.split('\n').filter(Boolean)).toEqual(['youtube id-old', 'youtube id-new']);
    });
  });

  describe('getDownloadStatuses / findEntryByVideoId', () => {
    it('returns statuses and last-updated dates from the index', async () => {
      await writeVideo(dir, '20240101_First', 'id-first');
      await writeVideo(dir, '20240102_NoVideo', 'id-novideo', { video: false });

      const statuses = await getDownloadStatuses(dir);

      expect(statuses.downloadStatuses).toEqual({ 'id-first': true });
      expect(Object.keys(statuses.lastUpdatedDates)).toEqual(['id-first']);
    });

    it('finds an entry by video id', async () => {
      await writeVideo(dir, '20240101_First', 'id-first');

      expect(await findEntryByVideoId(dir, 'id-first')).toMatchObject({
        baseName: '20240101_First',
      });
      expect(await findEntryByVideoId(dir, 'missing')).toBeNull();
    });
  });

  describe('readArchiveIds', () => {
    it('returns an empty set when archive.txt is missing', async () => {
      expect(await readArchiveIds(dir)).toEqual(new Set());
    });

    it('parses "<extractor> <id>" lines and ignores blanks', async () => {
      await fs.writeFile(path.join(dir, ARCHIVE_FILE), 'youtube aaa\n\nyoutube bbb\r\nvimeo ccc\n', 'utf-8');

      expect(await readArchiveIds(dir)).toEqual(new Set(['aaa', 'bbb', 'ccc']));
    });
  });
});
