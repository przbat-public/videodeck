import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { entry } from '../test-utils';
import { DESCRIPTION_PROBE_BYTES } from '../utils/infoJsonFlags';
import { logger } from '../utils/logger';
import {
  ARCHIVE_FILE,
  extractTitleFromHead,
  extractVideoIdFromHead,
  findEntryByVideoId,
  getDownloadStatuses,
  INDEX_FILE,
  INDEX_VERSION,
  indexUntrackedVideos,
  loadIndex,
  readArchiveIds,
  rebuildIndex,
  refreshIndex,
} from './folderIndex';

/** An info.json shaped like yt-dlp's: the metadata and formats first, the comment list last */
function ytDlpInfo(id: string, commentCount: number): string {
  const formats = Array.from({ length: 30 }, (_unused, n) => ({
    format_id: String(n),
    url: `https://rr1---sn.googlevideo.com/videoplayback?id=${id}&itag=${n}&sig=${'s'.repeat(1500)}`,
    ext: 'mp4',
    width: 1920,
    height: 1080,
  }));
  return JSON.stringify({
    id,
    title: `Video ${id}`,
    formats,
    description: 'A description with "quotes", a \\ backslash and a comments: [ decoy',
    automatic_captions: { en: [{ ext: 'vtt', url: 'https://www.youtube.com/api/timedtext?lang=en' }] },
    comment_count: commentCount,
    comments: Array.from({ length: commentCount }, (_unused, n) => ({
      id: `Ugx-${n}`,
      parent: 'root',
      text: `Comment number ${n}: ${'z'.repeat(360)}`,
      author: `@viewer${n}`,
      like_count: n,
    })),
  });
}

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
    vi.spyOn(console, 'error').mockImplementation(() => {
      /* silence expected error logs */
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
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

  describe('extractTitleFromHead', () => {
    it('reads the title yt-dlp writes right after the id, unescaped', () => {
      expect(extractTitleFromHead('{"id": "a1", "title": "Oven \\"v2\\" \\u0142\\u00f3d\\u017a", "formats": []')).toBe(
        'Oven "v2" łódź',
      );
    });

    it('returns null when the title is not the second key or is cut off by the head', () => {
      expect(extractTitleFromHead('{"id": "a1", "formats": [], "title": "late"}')).toBeNull();
      expect(extractTitleFromHead('{"id": "a1", "title": "cut off mid')).toBeNull();
      expect(extractTitleFromHead('not json')).toBeNull();
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

    it('records the video title from the info.json', async () => {
      await writeVideo(dir, '20240101_Oven', 'id-oven', {
        infoPrefix: JSON.stringify({ id: 'id-oven', title: 'Home built SMD Reflow Oven (v2)' }),
      });
      await writeVideo(dir, '20240102_Reordered', 'id-reordered', {
        infoPrefix: JSON.stringify({ description: 'd', title: 'Late title', id: 'id-reordered' }),
      });

      const index = await rebuildIndex(dir);

      expect(entry(index.entries, 'id-oven').title).toBe('Home built SMD Reflow Oven (v2)');
      expect(entry(index.entries, 'id-reordered').title).toBe('Late title');
    });

    it('records what the download actually left on disk', async () => {
      // The per-video badges and the "needs completing" count read this: the
      // boolean the console used to show could not tell a video without its
      // Polish subtitles from a complete one.
      await writeVideo(dir, '20240101_Full', 'id-full');
      await fs.writeFile(path.join(dir, '20240101_Full.webp'), 'thumb', 'utf-8');
      await fs.writeFile(path.join(dir, '20240101_Full.description'), 'text', 'utf-8');
      await fs.writeFile(path.join(dir, '20240101_Full.en.vtt'), 'subs', 'utf-8');
      await fs.writeFile(path.join(dir, '20240101_Full.pl.vtt'), 'subs', 'utf-8');
      await writeVideo(dir, '20240102_Bare', 'id-bare', {
        infoPrefix: JSON.stringify({ id: 'id-bare', title: 'No comments here' }),
      });

      const index = await rebuildIndex(dir);

      expect(entry(index.entries, 'id-full')).toMatchObject({
        subtitleLangs: ['en', 'pl'],
        hasComments: true,
        hasDescription: true,
      });
      expect(entry(index.entries, 'id-full').videoBytes).toBe(Buffer.byteLength('video-bytes'));
      // A video with nothing but its media files answers "no" everywhere
      // instead of leaving the keys out, so the client needs no fallbacks.
      expect(entry(index.entries, 'id-bare')).toMatchObject({
        subtitleLangs: [],
        hasComments: false,
        hasDescription: false,
      });
      expect(entry(index.entries, 'id-bare').videoBytes).toBe(Buffer.byteLength('video-bytes'));
    });

    it('answers the comment and description flags without parsing the info.json', async () => {
      // Two booleans cost a parse of the whole file, comments and all, for
      // every video of a rebuild: eight at once per folder, eight folders at
      // once behind the console
      await writeVideo(dir, '20240101_Heavy', 'id-heavy', { infoPrefix: ytDlpInfo('id-heavy', 4000) });
      await writeVideo(dir, '20240102_Quiet', 'id-quiet', {
        infoPrefix: JSON.stringify({ id: 'id-quiet', title: 'Quiet', description: 'Only in the info.json' }),
      });
      const parse = vi.spyOn(JSON, 'parse');

      const index = await rebuildIndex(dir);

      expect(entry(index.entries, 'id-heavy')).toMatchObject({ hasComments: true, hasDescription: true });
      expect(entry(index.entries, 'id-quiet')).toMatchObject({ hasComments: false, hasDescription: true });
      const longestParsed = Math.max(...parse.mock.calls.map(([text]) => String(text).length));
      expect(longestParsed).toBeLessThanOrEqual(DESCRIPTION_PROBE_BYTES + 2);
    });

    it('writes the index file and adds the videos it found to archive.txt', async () => {
      await writeVideo(dir, '20240101_First', 'id-first');
      await fs.writeFile(path.join(dir, ARCHIVE_FILE), 'youtube stale-id\n', 'utf-8');

      await rebuildIndex(dir);

      const saved = JSON.parse(await fs.readFile(path.join(dir, INDEX_FILE), 'utf-8'));
      expect(saved.version).toBe(2);
      expect(Object.keys(saved.entries)).toEqual(['id-first']);

      // A line the rebuild cannot account for stays: only the reconcile
      // endpoint, with its guard and its report, removes archive lines
      const archive = await fs.readFile(path.join(dir, ARCHIVE_FILE), 'utf-8');
      expect(archive).toBe('youtube stale-id\nyoutube id-first\n');
    });

    it('keeps every archive line it cannot read back from the disk', async () => {
      // A .webm the index does not list, a video downloaded without its
      // info.json, a line another extractor wrote: none of them is an
      // indexable video, and dropping their lines made the next channel
      // download fetch them again in full
      await writeVideo(dir, '20240101_First', 'id-first');
      await fs.writeFile(path.join(dir, '20240102_Webm.webm'), 'webm-bytes', 'utf-8');
      const archived = 'youtube id-webm\nyoutube id-without-info\nvimeo 123456789\nyoutube id-first\n';
      await fs.writeFile(path.join(dir, ARCHIVE_FILE), archived, 'utf-8');

      await rebuildIndex(dir);

      expect(await fs.readFile(path.join(dir, ARCHIVE_FILE), 'utf-8')).toBe(archived);
    });

    it('leaves archive.txt byte for byte as it was in a folder without an info.json', async () => {
      // That is how a drive that is away, or a scan that could not read a
      // single file, looks: rewriting the archive from it emptied the file
      await fs.writeFile(path.join(dir, ARCHIVE_FILE), 'youtube id-a\r\nyoutube id-b', 'utf-8');

      await rebuildIndex(dir);

      expect(await fs.readFile(path.join(dir, ARCHIVE_FILE), 'utf-8')).toBe('youtube id-a\r\nyoutube id-b');
    });

    it('falls back to a full JSON parse when id is not the first key', async () => {
      await writeVideo(dir, '20240101_Reordered', 'id-reordered', {
        infoPrefix: JSON.stringify({ title: 't', id: 'id-reordered' }),
      });

      const index = await rebuildIndex(dir);

      expect(Object.keys(index.entries)).toEqual(['id-reordered']);
    });

    it('counts the comments of an info.json past the string limit, which it cannot parse', async () => {
      // Past V8's longest string the parse fails, and the entry said no
      // comments: the console then offered a comment repair for the very
      // file that holds them, and that repair keeps a file this size as it is
      await writeVideo(dir, '20240101_Huge', 'id-huge');
      const realStat = fs.stat;
      vi.spyOn(fs, 'stat').mockImplementation(async (file) => {
        const stats = await realStat(file);
        return String(file).endsWith('.info.json') ? Object.assign(stats, { size: 600 * 1024 * 1024 }) : stats;
      });
      const realReadFile = fs.readFile;
      vi.spyOn(fs, 'readFile').mockImplementation(async (file, options) => {
        if (String(file).endsWith('.info.json')) {
          throw new RangeError('Invalid string length');
        }
        return realReadFile(file, options);
      });

      const index = await rebuildIndex(dir);

      expect(entry(index.entries, 'id-huge').hasComments).toBe(true);
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

    it('lets several readers rebuild the same folder at the same time', async () => {
      await writeVideo(dir, '20240101_First', 'id-first');
      await writeVideo(dir, '20240102_Second', 'id-second');

      // A folder without an index gets rebuilt by whoever asks first, and more
      // than one rebuild can be asked for at once (the rebuild endpoint next
      // to a reader). They run in turn in the folder's write chain, each
      // writing the index through a temp file of its own, and archive.txt is
      // appended rather than rewritten, so every id ends up in it once.
      const readers = await Promise.all(Array.from({ length: 5 }, () => rebuildIndex(dir)));

      for (const index of readers) {
        expect(Object.keys(index.entries).sort()).toEqual(['id-first', 'id-second']);
      }
      await expect(readArchiveIds(dir)).resolves.toEqual(new Set(['id-first', 'id-second']));
    });

    it('lets readers that find no index share one rebuild, so archive.txt gets each line once', async () => {
      // Two tabs, or a page and the library frame behind it: each reader that
      // finds no index used to start its own scan, and each scan appended the
      // ids it found to the archive
      await writeVideo(dir, '20240101_First', 'id-first');
      await writeVideo(dir, '20240102_Second', 'id-second');

      const readers = await Promise.all(Array.from({ length: 20 }, () => loadIndex(dir)));

      for (const index of readers) {
        expect(Object.keys(index.entries).sort()).toEqual(['id-first', 'id-second']);
      }
      const archive = await fs.readFile(path.join(dir, ARCHIVE_FILE), 'utf-8');
      expect(archive).toBe('youtube id-first\nyoutube id-second\n');
    });
  });

  describe('writes to one folder', () => {
    const HOUR_MS = 60 * 60 * 1000;

    /** A video whose info.json was last written `agedMs` ago */
    async function writeAgedVideo(baseName: string, id: string, agedMs: number): Promise<void> {
      await writeVideo(dir, baseName, id);
      const then = new Date(Date.now() - agedMs);
      await fs.utimes(path.join(dir, `${baseName}.info.json`), then, then);
    }

    /** Holds the first open of an info.json, the head read of a scan, until release() */
    function holdFirstInfoOpen(): { reached: Promise<void>; release: () => void; opens: () => number } {
      const realOpen = fs.open;
      let release: () => void = () => undefined;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let signalReached: () => void = () => undefined;
      const reached = new Promise<void>((resolve) => {
        signalReached = resolve;
      });
      let opens = 0;
      vi.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
        if (String(file).endsWith('.info.json')) {
          opens += 1;
          if (opens === 1) {
            signalReached();
            await released;
          }
        }
        return realOpen(file, flags, mode);
      });
      return { reached, release, opens: () => opens };
    }

    /** The reads of the index file started so far, each settling whether it found the file or not */
    function recordIndexReads(): () => Promise<unknown>[] {
      const realReadFile = fs.readFile;
      const reads: Promise<unknown>[] = [];
      vi.spyOn(fs, 'readFile').mockImplementation((file, options) => {
        const result = realReadFile(file, options);
        if (String(file).endsWith(INDEX_FILE)) {
          reads.push(result.catch(() => undefined));
        }
        return result;
      });
      return () => [...reads];
    }

    const storedIds = async (): Promise<string[]> => Object.keys((await loadIndex(dir)).entries).sort();

    it('keeps the video a job refresh adds while a reader rebuild is still scanning', async () => {
      await writeAgedVideo('20240101_First', 'id-first', HOUR_MS);
      const held = holdFirstInfoOpen();
      const indexReads = recordIndexReads();

      // A reader finds no index and rebuilds it from a listing taken before
      // the job's files landed; the job's refresh found no index either and
      // rebuilt it too, and whichever saved last decided what the folder held
      const reader = loadIndex(dir);
      await held.reached;
      await writeVideo(dir, '20240102_Second', 'id-second');
      const refresh = refreshIndex(dir, Date.now() - 1000);
      await Promise.all(indexReads());
      held.release();
      const [, refreshed] = await Promise.all([reader, refresh]);

      expect(refreshed.changed).toEqual(['id-second']);
      expect(await storedIds()).toEqual(['id-first', 'id-second']);
    });

    it('keeps both videos when a collection read and a job refresh index the folder at once', async () => {
      await writeAgedVideo('20240101_First', 'id-first', HOUR_MS);
      await rebuildIndex(dir);
      // Moved in from another folder: an old mtime, and never indexed
      await writeAgedVideo('20230101_MovedIn', 'id-moved', 24 * HOUR_MS);
      const held = holdFirstInfoOpen();
      const indexReads = recordIndexReads();

      // Each read the index, added its own video and saved: the later save
      // dropped the other one's
      const collectionRead = indexUntrackedVideos(dir);
      await held.reached;
      await writeVideo(dir, '20240102_Second', 'id-second');
      const refresh = refreshIndex(dir, Date.now() - 1000);
      await Promise.all(indexReads());
      held.release();
      await Promise.all([collectionRead, refresh]);

      expect(await storedIds()).toEqual(['id-first', 'id-moved', 'id-second']);
    });

    it('lets a reader that finds no index wait for a rebuild in flight instead of scanning again', async () => {
      await writeVideo(dir, '20240101_First', 'id-first');
      await writeVideo(dir, '20240102_Second', 'id-second');
      const held = holdFirstInfoOpen();
      const indexReads = recordIndexReads();

      const rebuild = rebuildIndex(dir);
      await held.reached;
      const reader = loadIndex(dir);
      await Promise.all(indexReads());
      held.release();
      const [, read] = await Promise.all([rebuild, reader]);

      expect(Object.keys(read.entries).sort()).toEqual(['id-first', 'id-second']);
      // One scan opens each of the two heads once
      expect(held.opens()).toBe(2);
    });

    it('runs the next index write after one that failed', async () => {
      await writeVideo(dir, '20240101_First', 'id-first');
      vi.spyOn(fs, 'rename').mockRejectedValueOnce(
        Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }),
      );

      await expect(rebuildIndex(dir)).rejects.toThrow('EACCES');

      expect(await storedIds()).toEqual(['id-first']);
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

    it('rebuilds an index written before the per-file state existed', async () => {
      // Version 1 entries carry no subtitle or comment information, so keeping
      // them would report every video as incomplete until the next download.
      await writeVideo(dir, '20240101_First', 'id-first');
      await fs.writeFile(path.join(dir, '20240101_First.pl.vtt'), 'subs', 'utf-8');
      await fs.writeFile(
        path.join(dir, INDEX_FILE),
        JSON.stringify({
          version: 1,
          builtAt: '2024-01-01T00:00:00.000Z',
          entries: {
            'id-first': {
              baseName: '20240101_First',
              videoFile: '20240101_First.mp4',
              infoMtime: '2024-01-01T00:00:00.000Z',
            },
          },
        }),
        'utf-8',
      );

      const index = await loadIndex(dir);

      expect(index.version).toBe(2);
      expect(entry(index.entries, 'id-first').subtitleLangs).toEqual(['pl']);
      const saved = JSON.parse(await fs.readFile(path.join(dir, INDEX_FILE), 'utf-8'));
      expect(saved.version).toBe(2);
    });

    it('drops an entry whose baseName could leave the folder', async () => {
      // The index is a file on the video folder, which is a network share as
      // often as it is a local disk, and a stem with a separator reaches
      // yt-dlp's -o template. Every entry is checked where it is read.
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {
        /* the drop is the assertion */
      });
      const entryFor = (baseName: string) => ({
        baseName,
        videoFile: `${baseName}.mp4`,
        infoMtime: '2024-01-01T00:00:00.000Z',
        subtitleLangs: [],
        hasComments: false,
        hasDescription: false,
        videoBytes: 0,
      });
      await fs.writeFile(
        path.join(dir, INDEX_FILE),
        JSON.stringify({
          version: INDEX_VERSION,
          builtAt: '2024-01-01T00:00:00.000Z',
          entries: {
            'id-good': entryFor('20240101_Good'),
            'id-escape': entryFor('../../etc/passwd'),
            'id-slash': entryFor('sub/dir'),
            'id-backslash': entryFor('sub\\dir'),
            'id-dot': entryFor('..'),
            'id-empty': entryFor(''),
            'id-nul': entryFor('a\u0000b'),
            'id-long': entryFor('x'.repeat(201)),
          },
        }),
        'utf-8',
      );

      const index = await loadIndex(dir);

      expect(Object.keys(index.entries)).toEqual(['id-good']);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('baseName');
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

    it('re-reads a stem it is told about, whatever its info.json mtime', async () => {
      // What a sidecar repair leaves behind: the info.json it kept
      // (--no-overwrites) is as old as before, and a new subtitle sits next
      // to it
      await writeVideo(dir, '20240101_Repaired', 'id-repaired');
      await rebuildIndex(dir);
      const past = new Date(Date.now() - 60_000);
      await fs.utimes(path.join(dir, '20240101_Repaired.info.json'), past, past);
      const since = Date.now();
      await fs.writeFile(path.join(dir, '20240101_Repaired.pl.vtt'), 'WEBVTT\n', 'utf-8');

      const missed = await refreshIndex(dir, since);
      expect(missed.changed).toEqual([]);

      const result = await refreshIndex(dir, since, ['20240101_Repaired']);

      expect(result.changed).toEqual(['id-repaired']);
      expect(entry(result.index.entries, 'id-repaired').subtitleLangs).toEqual(['pl']);
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

    it('drops entries whose files were deleted from disk', async () => {
      await writeVideo(dir, '20240101_Keep', 'id-keep');
      await writeVideo(dir, '20240102_Gone', 'id-gone');
      await rebuildIndex(dir);
      // delete the video + info.json of one entry, then run an incremental refresh
      await fs.rm(path.join(dir, '20240102_Gone.info.json'));
      await fs.rm(path.join(dir, '20240102_Gone.mp4'));

      const result = await refreshIndex(dir, Date.now() - 1000);

      expect(result.removed).toEqual(['id-gone']);
      expect(result.index.entries['id-gone']).toBeUndefined();
      expect(result.index.entries['id-keep']).toBeDefined();
    });

    it('never mass-wipes the index when the folder looks empty (unmounted drive)', async () => {
      await writeVideo(dir, '20240101_Keep', 'id-keep');
      await rebuildIndex(dir);
      // delete the video files but keep the index file — the folder looks
      // empty to the scan (dotfiles are skipped), like an unmounted drive
      await fs.rm(path.join(dir, '20240101_Keep.info.json'));
      await fs.rm(path.join(dir, '20240101_Keep.mp4'));

      const result = await refreshIndex(dir, Date.now() - 1000);

      expect(result.removed).toEqual([]);
      expect(result.index.entries['id-keep']).toBeDefined();
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

  describe('indexUntrackedVideos', () => {
    it('adds videos the index has never seen, however old their files are', async () => {
      await writeVideo(dir, '20240101_Tracked', 'id-tracked');
      await rebuildIndex(dir);
      // downloaded by yt-dlp in a terminal long ago, then moved in: the
      // mtime predates the index, so an mtime-based refresh would miss it
      await writeVideo(dir, '20200101_MovedIn', 'id-moved');
      const past = new Date('2020-01-02T00:00:00Z');
      await fs.utimes(path.join(dir, '20200101_MovedIn.info.json'), past, past);

      const result = await indexUntrackedVideos(dir);

      expect(result.changed).toEqual(['id-moved']);
      expect(entry(result.index.entries, 'id-moved')).toMatchObject({
        baseName: '20200101_MovedIn',
        title: '20200101_MovedIn',
        infoMtime: past.toISOString(),
      });
      expect(await readArchiveIds(dir)).toEqual(new Set(['id-tracked', 'id-moved']));
    });

    it('leaves the index file alone when every video is already tracked', async () => {
      await writeVideo(dir, '20240101_Tracked', 'id-tracked');
      await rebuildIndex(dir);
      const indexPath = path.join(dir, INDEX_FILE);
      const past = new Date('2024-01-01T00:00:00Z');
      await fs.utimes(indexPath, past, past);

      const result = await indexUntrackedVideos(dir);

      expect(result.changed).toEqual([]);
      expect((await fs.stat(indexPath)).mtimeMs).toBe(past.getTime());
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
