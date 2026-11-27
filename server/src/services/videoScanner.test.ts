import type { Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import type { Mock, Mocked } from 'vitest';
import * as config from '../config';
import { at } from '../test-utils';
import { logger } from '../utils/logger';
import { MAX_COMMENTS_CHARS } from './elasticsearch/bulkIndexing';
import type { VideoDocument } from './elasticsearchService';
import * as elasticsearchService from './elasticsearchService';
import {
  buildVideoItem,
  describeError,
  findVideoFiles,
  getReindexStatus,
  getVideos,
  indexVideosFromDisk,
  isReindexRunning,
  loadVideosCache,
  MAX_TRANSCRIPT_CHARS,
  REINDEX_BATCH_BYTES,
  REINDEX_BATCH_SIZE,
  refreshVideosCache,
} from './videoScanner';

vi.mock('node:fs/promises');
vi.mock('../config');
// Vitest has no createMockFromModule: the bare mock replaces every export of
// the service with a spy, and the real document helpers are put back below.
vi.mock('./elasticsearchService');

/**
 * The real module behind the automock. `vi.importActual` returns a promise, so
 * the capture moves into a hook and the three pure helpers keep their real
 * implementation through the spy that the automock installed in their place.
 */
let realEs: typeof import('./elasticsearchService');
beforeAll(async () => {
  realEs = await vi.importActual<typeof import('./elasticsearchService')>('./elasticsearchService');
});

const mockedFs = fs as Mocked<typeof fs>;
/** The scanner only uses the `readdir(path) → string[]` overload */
const readdirMock = mockedFs.readdir as unknown as Mock<(path: string) => Promise<string[]>>;
const mockedConfig = config as Mocked<typeof config>;
const mockedEs = elasticsearchService as Mocked<typeof elasticsearchService>;

const FOLDER = '/test/videos';
const NEW_INDEX = 'videos_abc_20250101000000000';

/** All documents passed to bulkIndexDocuments, in order */
function bulkIndexedVideos(): VideoDocument[] {
  return mockedEs.bulkIndexDocuments.mock.calls.flatMap(([, documents]) => documents);
}

/** A cue time stamp, HH:MM:SS.mmm */
function cueTime(ms: number): string {
  return new Date(ms).toISOString().slice(11, 23);
}

/**
 * A rolling auto-caption track, the way yt-dlp writes YouTube's automatic
 * captions (test/fixtures/ytdlp-real.vtt): every line is typed in word by word
 * under the line before it, then held alone in a 10 ms cue.
 */
function rollingAutoCaptions(lines: string[]): string {
  const cues = ['WEBVTT', 'Kind: captions', 'Language: pl', ''];
  for (const [n, line] of lines.entries()) {
    const start = n * 3000;
    const [first, ...rest] = line.split(' ');
    const typed = `${first}${rest.map((word, w) => `<${cueTime(start + (w + 1) * 300)}><c> ${word}</c>`).join('')}`;
    cues.push(`${cueTime(start)} --> ${cueTime(start + 2990)} align:start position:0%`, lines[n - 1] ?? ' ', typed, '');
    cues.push(`${cueTime(start + 2990)} --> ${cueTime(start + 3000)} align:start position:0%`, line, ' ', '');
  }
  return cues.join('\n');
}

/** Past V8's longest string (536,870,888 code units on Node 24), so the file cannot be read as one */
const PAST_STRING_LIMIT_BYTES = 600 * 1024 * 1024;

/** A FileHandle stand-in for a file of `size` bytes that starts with `head` */
function fakeHandle(head: string, size: number): FileHandle {
  const bytes = Buffer.from(head, 'utf-8');
  const handle = {
    read: async (buffer: Buffer, offset: number, length: number, position: number) => ({
      bytesRead: bytes.copy(buffer, offset, position, position + length),
      buffer,
    }),
    stat: async () => ({ size }),
    close: async () => undefined,
  };
  return handle as unknown as FileHandle;
}

function mockFolder(files: string[], infoJson: Record<string, unknown> = { title: 'Test Video 1' }) {
  mockedConfig.getVideosFolderPaths.mockReturnValue([FOLDER]);
  readdirMock.mockResolvedValue(files);
  mockedFs.readFile.mockResolvedValue(JSON.stringify(infoJson));
}

describe('videoScanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {
      /* silence expected info logs */
    });
    vi.spyOn(console, 'error').mockImplementation(() => {
      /* silence expected error logs */
    });

    // pure helpers keep their real implementation
    mockedEs.toDocument.mockImplementation(realEs.toDocument);
    mockedEs.fromDocument.mockImplementation(realEs.fromDocument);
    mockedEs.estimateDocumentBytes.mockImplementation(realEs.estimateDocumentBytes);
    mockedFs.realpath.mockImplementation((p) => Promise.resolve(String(p)));
    // An info.json of an ordinary size, read whole
    mockedFs.stat.mockResolvedValue({ size: 1024 } as Stats);
    mockedEs.checkElasticsearchConnection.mockResolvedValue(true);
    mockedEs.createIndexVersion.mockResolvedValue(NEW_INDEX);
    mockedEs.bulkIndexDocuments.mockImplementation(async (_index, documents) => ({
      indexed: documents.length,
      skipped: 0,
    }));
    mockedEs.promoteIndexVersion.mockResolvedValue(undefined);
    mockedEs.discardIndexVersion.mockResolvedValue(undefined);
    mockedEs.indexVideo.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getVideos', () => {
    it('should return videos from Elasticsearch', async () => {
      const mockVideos = [
        {
          baseName: '20231201_TestVideo1',
          title: 'Test Video 1',
          description: 'Description 1',
          videoPath: '20231201_TestVideo1.mp4',
          thumbnailPath: '20231201_TestVideo1.webp',
          folderPath: FOLDER,
          comments: [],
        },
      ];
      mockedEs.searchVideosWithTotal.mockResolvedValue({ videos: mockVideos, total: 1 });

      const result = await getVideos('');
      expect(result.videos.length).toBe(1);
      expect(at(result.videos, 0).title).toBe('Test Video 1');
      expect(at(result.videos, 0).folderPath).toBe(FOLDER);
      expect(result.total).toBe(1);
      expect(mockedEs.searchVideosWithTotal).toHaveBeenCalledWith('', 'date-desc', undefined, undefined);
    });

    it('should pass query and sort option through', async () => {
      mockedEs.searchVideos.mockResolvedValue([]);

      await getVideos('test', 'views-desc');
      expect(mockedEs.searchVideosWithTotal).toHaveBeenCalledWith('test', 'views-desc', undefined, undefined);

      await getVideos('test', 'views-desc', ['/videos/a'], { offset: 10, limit: 20 });
      expect(mockedEs.searchVideosWithTotal).toHaveBeenLastCalledWith('test', 'views-desc', ['/videos/a'], {
        offset: 10,
        limit: 20,
      });
    });
  });

  describe('findVideoFiles', () => {
    it('collects every subtitle language while keeping the english one primary', () => {
      const found = findVideoFiles('20231201_X', [
        '20231201_X.info.json',
        '20231201_X.mp4',
        '20231201_X.webp',
        '20231201_X.en.vtt',
        '20231201_X.pl.vtt',
        '20231201_X.de.vtt',
        '20231201_Other.en.vtt',
      ]);

      expect(found.subtitleFile).toBe('20231201_X.en.vtt');
      expect(found.subtitleFiles).toEqual(['20231201_X.en.vtt', '20231201_X.pl.vtt', '20231201_X.de.vtt']);
    });

    it('falls back to any subtitle language when there is no english one', () => {
      const found = findVideoFiles('20231201_X', [
        '20231201_X.info.json',
        '20231201_X.mp4',
        '20231201_X.webp',
        '20231201_X.pl.vtt',
      ]);

      // Polish-only videos are summarizable too — the primary slot falls
      // back instead of staying empty (which used to 404 on every visit).
      expect(found.subtitleFile).toBe('20231201_X.pl.vtt');
      expect(found.subtitleFiles).toEqual(['20231201_X.pl.vtt']);
    });

    it('never takes the subtitles of a sibling video whose stem extends this one', () => {
      // Older names are <upload_date>_<title> and keep a title's dot, so
      // "Part 1.5" is the video 20240101_Part_1.5 beside "Part 1", and every
      // caption of it starts with the stem of the other one. Indexed as Part
      // 1's, they made a search for words spoken in Part 1.5 return Part 1.
      const listing = [
        '20240101_Part_1.info.json',
        '20240101_Part_1.mp4',
        '20240101_Part_1.webp',
        '20240101_Part_1.5.info.json',
        '20240101_Part_1.5.mp4',
        '20240101_Part_1.5.webp',
        '20240101_Part_1.5.pl.vtt',
        '20240101_Part_1.5.en.vtt',
        '20240101_Part_1.5.vtt',
      ];

      const first = findVideoFiles('20240101_Part_1', listing);
      expect(first.subtitleFiles).toEqual([]);
      expect(first.subtitleFile).toBeUndefined();
      const sibling = findVideoFiles('20240101_Part_1.5', listing);
      expect(sibling.subtitleFiles).toEqual([
        '20240101_Part_1.5.pl.vtt',
        '20240101_Part_1.5.en.vtt',
        '20240101_Part_1.5.vtt',
      ]);
      expect(sibling.subtitleFile).toBe('20240101_Part_1.5.en.vtt');
    });

    it('accepts the numbered thumbnail variants yt-dlp writes for every size', () => {
      // `--write-all-thumbnails` names the variants `<video>.<level>.<ext>`, so
      // a channel downloaded that way used to lose EVERY video to the
      // "missing thumbnail" skip (360 videos in electronics-mr-electron).
      const found = findVideoFiles('20231201_X', [
        '20231201_X.info.json',
        '20231201_X.mp4',
        '20231201_X.mp4_0.jpg',
        '20231201_X.mp4_1.jpg',
        '20231201_X.mp4_4.webp',
      ]);

      expect(found.thumbnailFile).toBe('20231201_X.mp4_4.webp');
    });

    it('prefers the plain sidecar over a numbered variant', () => {
      const found = findVideoFiles('20231201_X', [
        '20231201_X.info.json',
        '20231201_X.mp4',
        '20231201_X.webp',
        '20231201_X.mp4_4.webp',
      ]);

      expect(found.thumbnailFile).toBe('20231201_X.webp');
    });

    it('takes the highest variant that exists, not a fixed level', () => {
      const found = findVideoFiles('20231201_X', [
        '20231201_X.info.json',
        '20231201_X.mp4',
        '20231201_X.mp4_0.jpg',
        '20231201_X.mp4_3.webp',
      ]);

      expect(found.thumbnailFile).toBe('20231201_X.mp4_3.webp');
    });

    it('never borrows the variants of a different video', () => {
      const found = findVideoFiles('20231201_X', [
        '20231201_X.info.json',
        '20231201_X.mp4',
        '20231201_X_extra.mp4_4.webp',
      ]);

      expect(found.thumbnailFile).toBeUndefined();
    });

    it('takes a .png, .jpeg or variant thumbnail, the rule the folder console counts by', () => {
      // The console counted these as thumbnails while the index skipped the
      // video for missing one, so it showed no gap and offered no repair
      const thumbnailOf = (...images: string[]) =>
        findVideoFiles('20231201_X', ['20231201_X.info.json', '20231201_X.mp4', ...images]).thumbnailFile;

      expect(thumbnailOf('20231201_X.png')).toBe('20231201_X.png');
      expect(thumbnailOf('20231201_X.JPEG')).toBe('20231201_X.JPEG');
      // Current yt-dlp names a variant <stem>.<level>.<ext>, older releases <stem>.mp4_<level>.<ext>
      expect(thumbnailOf('20231201_X.0.jpg', '20231201_X.3.png')).toBe('20231201_X.3.png');
      expect(thumbnailOf('20231201_X.en.png')).toBeUndefined();
    });
  });

  describe('buildVideoItem', () => {
    const files = [
      '20231201_TestVideo1.info.json',
      '20231201_TestVideo1.mp4',
      '20231201_TestVideo1.webp',
      '20231201_TestVideo1.en.vtt',
    ];

    it('builds a full item from info.json and sidecar files', async () => {
      mockedFs.readFile.mockImplementation(async (filePath: unknown) => {
        const path = String(filePath);
        if (path.endsWith('.vtt')) {
          return 'WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nHello transcript world';
        }
        return JSON.stringify({
          id: 'abcdefghijk',
          title: 'Test Video 1',
          description: 'Desc',
          upload_date: '20231201',
          view_count: 1000,
          like_count: 50,
          channel: 'Test Channel',
          comments: [{ id: 'c1', text: 'hello' }],
        });
      });

      const result = await buildVideoItem(FOLDER, '20231201_TestVideo1', files);

      expect(result.status).toBe('ok');
      if (result.status !== 'ok') return;
      expect(result.video).toMatchObject({
        baseName: '20231201_TestVideo1',
        videoId: 'abcdefghijk',
        title: 'Test Video 1',
        description: 'Desc',
        videoPath: '20231201_TestVideo1.mp4',
        thumbnailPath: '20231201_TestVideo1.webp',
        subtitlePath: '20231201_TestVideo1.en.vtt',
        folderPath: FOLDER,
        uploadDate: '20231201',
        viewCount: 1000,
        likeCount: 50,
        channelName: 'Test Channel',
        transcriptText: 'Hello transcript world',
      });
      expect(result.video.comments).toHaveLength(1);
      expect(mockedFs.readFile).toHaveBeenCalledWith(`${FOLDER}/20231201_TestVideo1.info.json`, 'utf-8');
      expect(mockedFs.readFile).toHaveBeenCalledWith(`${FOLDER}/20231201_TestVideo1.en.vtt`, 'utf-8');
    });

    it('indexes a video whose only thumbnail is a numbered variant', async () => {
      mockedFs.readFile.mockResolvedValue(JSON.stringify({ id: 'abcdefghijk', title: 'T' }));

      const result = await buildVideoItem(FOLDER, '20231201_TestVideo1', [
        '20231201_TestVideo1.info.json',
        '20231201_TestVideo1.mp4',
        '20231201_TestVideo1.mp4_0.jpg',
        '20231201_TestVideo1.mp4_4.webp',
      ]);

      expect(result.status).toBe('ok');
      if (result.status !== 'ok') return;
      expect(result.video.thumbnailPath).toBe('20231201_TestVideo1.mp4_4.webp');
    });

    it('indexes the transcript of every subtitle language on disk', async () => {
      mockedFs.readFile.mockImplementation(async (filePath: unknown) => {
        const p = String(filePath);
        if (p.endsWith('.pl.vtt')) {
          return 'WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nPo polsku';
        }
        if (p.endsWith('.en.vtt')) {
          return 'WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nIn English';
        }
        return JSON.stringify({ id: 'abcdefghijk', title: 'T' });
      });

      const result = await buildVideoItem(FOLDER, '20231201_TestVideo1', [...files, '20231201_TestVideo1.pl.vtt']);

      expect(result.status).toBe('ok');
      if (result.status !== 'ok') return;
      expect(result.video.transcriptText).toBe('In English\n\nPo polsku');
      expect(result.video.subtitlePath).toBe('20231201_TestVideo1.en.vtt');
    });

    it('indexes a long auto-caption track whole, each line once', async () => {
      // 1,500 lines, about 75 minutes of a rolling track: with every line
      // tripled the transcript passed the cap and lost its lines from 956 on
      const lines = Array.from({ length: 1500 }, (_unused, n) => `zdanie numer ${n} mowione do kamery`);
      mockedFs.readFile.mockImplementation(async (filePath: unknown) =>
        String(filePath).endsWith('.vtt')
          ? rollingAutoCaptions(lines)
          : JSON.stringify({ id: 'abcdefghijk', title: 'T' }),
      );

      const result = await buildVideoItem(FOLDER, '20231201_TestVideo1', files);

      expect(result.status).toBe('ok');
      if (result.status !== 'ok') return;
      expect(result.video.transcriptText).toBe(lines.join(' '));
      expect(lines.join(' ').length).toBeLessThan(MAX_TRANSCRIPT_CHARS);
    });

    it('falls back to baseName date, uploader and a title derived from the file name', async () => {
      mockedFs.readFile.mockResolvedValue(JSON.stringify({ uploader: 'Test Uploader' }));

      const result = await buildVideoItem(FOLDER, '20231201_Test_Video1', [
        '20231201_Test_Video1.info.json',
        '20231201_Test_Video1.mkv',
        '20231201_Test_Video1.jpg',
      ]);

      expect(result.status).toBe('ok');
      if (result.status !== 'ok') return;
      expect(result.video.uploadDate).toBe('20231201');
      expect(result.video.channelName).toBe('Test Uploader');
      expect(result.video.title).toBe('Test Video1');
      expect(result.video.videoPath).toBe('20231201_Test_Video1.mkv');
      expect(result.video.thumbnailPath).toBe('20231201_Test_Video1.jpg');
      expect(result.video.subtitlePath).toBeUndefined();
    });

    it('takes the title and the description from fulltitle when the info.json has neither', async () => {
      // The details view shows the indexed fields, so this fallback is the only one
      mockedFs.readFile.mockResolvedValue(JSON.stringify({ id: 'abcdefghijk', fulltitle: 'Full Title Only' }));

      const result = await buildVideoItem(FOLDER, '20231201_TestVideo1', [
        '20231201_TestVideo1.info.json',
        '20231201_TestVideo1.mp4',
      ]);

      expect(result.status).toBe('ok');
      if (result.status !== 'ok') return;
      expect(result.video).toMatchObject({ title: 'Full Title Only', description: 'Full Title Only' });
    });

    it('leaves the id out of a title derived from a stem that ends in it', async () => {
      // Downloads name their files <date>_<title>_<id>; an id can hold `_` and
      // `-`, so it is matched as the whole suffix, never by splitting
      mockedFs.readFile.mockResolvedValue(JSON.stringify({ id: '-abc_def-gh' }));
      const stem = '20231201_Test_Video1_-abc_def-gh';

      const result = await buildVideoItem(FOLDER, stem, [`${stem}.info.json`, `${stem}.mp4`, `${stem}.webp`]);

      expect(result.status).toBe('ok');
      if (result.status !== 'ok') return;
      expect(result.video.title).toBe('Test Video1');
    });

    it('keeps the last word of an older stem that only looks like an id', async () => {
      mockedFs.readFile.mockResolvedValue(JSON.stringify({ id: 'xyzXYZ01234' }));
      const stem = '20231201_Lesson_Programming';

      const result = await buildVideoItem(FOLDER, stem, [`${stem}.info.json`, `${stem}.mp4`, `${stem}.webp`]);

      expect(result.status).toBe('ok');
      if (result.status !== 'ok') return;
      expect(result.video.title).toBe('Lesson Programming');
    });

    it('parses a real yt-dlp info.json fixture', async () => {
      const realFs = (await vi.importActual<typeof import('fs/promises')>(
        'fs/promises',
      )) as typeof import('fs/promises');
      const info = await realFs.readFile(`${__dirname}/../test/fixtures/ytdlp-info.json`, 'utf-8');
      mockedFs.readFile.mockResolvedValue(info);

      const result = await buildVideoItem(FOLDER, '20060429_Fighting_moonlighters', [
        '20060429_Fighting_moonlighters.info.json',
        '20060429_Fighting_moonlighters.mp4',
        '20060429_Fighting_moonlighters.webp',
      ]);

      expect(result.status).toBe('ok');
      if (result.status !== 'ok') return;
      expect(result.video).toMatchObject({
        videoId: '4wLuvRB3axg',
        title: 'Fighting moonlighters',
        uploadDate: '20060429',
        viewCount: 1363,
        likeCount: 12,
        channelName: 'Andrew Newton',
      });
      expect(result.video.comments ?? []).toHaveLength(2);
      expect(result.video.comments?.[0]).toMatchObject({ id: 'Ugx1comment1', parent: 'root' });
      expect(result.video.comments?.[1]).toMatchObject({
        id: 'Ugx2comment2',
        parent: 'Ugx1comment1',
      });
    });

    it('indexes a video with no thumbnail, thumbnailPath left out', async () => {
      // A folder downloaded with --no-write-thumbnail, or one whose image went
      // missing: the video and its info.json are all a search result needs
      mockedFs.readFile.mockResolvedValue(JSON.stringify({ id: 'abcdefghijk', title: 'Bez miniatury' }));

      const result = await buildVideoItem(FOLDER, 'a', ['a.info.json', 'a.mp4']);

      expect(result.status).toBe('ok');
      if (result.status !== 'ok') return;
      expect(result.video).toMatchObject({ baseName: 'a', title: 'Bez miniatury', videoPath: 'a.mp4' });
      expect(result.video).not.toHaveProperty('thumbnailPath');
    });

    it('skips when the video file is missing', async () => {
      const result = await buildVideoItem(FOLDER, '20231201_TestVideo1', [
        '20231201_TestVideo1.info.json',
        '20231201_TestVideo1.webp',
      ]);

      expect(result).toEqual({
        status: 'skipped',
        reason: expect.stringContaining('missing video file'),
      });
      expect(mockedFs.readFile).not.toHaveBeenCalled();
    });

    it('indexes a video whose info.json is past the string limit, from its head and without comments', async () => {
      // readFile fails on such a file the way Node does, and the video left
      // search; its head still names the id and the title yt-dlp writes first
      const stem = '20231201_Huge_video_hugeVideo01';
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      mockedFs.stat.mockResolvedValue({ size: PAST_STRING_LIMIT_BYTES } as Stats);
      mockedFs.readFile.mockRejectedValue(new RangeError('Invalid string length'));
      mockedFs.open.mockResolvedValue(
        fakeHandle('{"id": "hugeVideo01", "title": "Huge video", "formats": [', PAST_STRING_LIMIT_BYTES),
      );

      const result = await buildVideoItem(FOLDER, stem, [`${stem}.info.json`, `${stem}.mp4`]);

      expect(result).toMatchObject({
        status: 'ok',
        video: { videoId: 'hugeVideo01', title: 'Huge video', uploadDate: '20231201', comments: [] },
      });
      expect(mockedFs.readFile).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('skips a video whose info.json is past the string limit and names no id in its head, unread', async () => {
      const stem = '20231201_Huge_video';
      mockedFs.stat.mockResolvedValue({ size: PAST_STRING_LIMIT_BYTES } as Stats);
      mockedFs.readFile.mockRejectedValue(new RangeError('Invalid string length'));
      mockedFs.open.mockResolvedValue(
        fakeHandle('{"title": "Huge video", "id": "late", "formats": [', PAST_STRING_LIMIT_BYTES),
      );

      const result = await buildVideoItem(FOLDER, stem, [`${stem}.info.json`, `${stem}.mp4`]);

      expect(result).toEqual({ status: 'skipped', reason: expect.stringContaining('too large to read') });
      expect(mockedFs.readFile).not.toHaveBeenCalled();
    });

    it('skips when info.json is not valid JSON', async () => {
      mockedFs.readFile.mockResolvedValue('not json');

      const result = await buildVideoItem(FOLDER, '20231201_TestVideo1', files);

      expect(result).toEqual({
        status: 'skipped',
        reason: expect.stringContaining('cannot read info.json'),
      });
    });
  });

  describe('loadVideosCache', () => {
    it('writes into a new index version and promotes it, without touching the live index', async () => {
      mockFolder([
        '20231201_TestVideo1.info.json',
        '20231201_TestVideo1.mp4',
        '20231201_TestVideo1.webp',
        '20231115_TestVideo2.info.json',
        '20231115_TestVideo2.mp4',
        '20231115_TestVideo2.webp',
      ]);
      mockedFs.readFile
        .mockResolvedValueOnce(
          JSON.stringify({
            title: 'Test Video 1',
            upload_date: '20231201',
            view_count: 1000,
            like_count: 50,
            channel: 'Test Channel',
          }),
        )
        .mockResolvedValueOnce(JSON.stringify({ title: 'Test Video 2' }));

      await loadVideosCache();

      expect(mockedEs.createIndexVersion).toHaveBeenCalledWith(FOLDER);
      expect(mockedEs.bulkIndexDocuments).toHaveBeenCalledTimes(1);
      expect(mockedEs.bulkIndexDocuments).toHaveBeenCalledWith(NEW_INDEX, expect.any(Array), false);
      expect(mockedEs.promoteIndexVersion).toHaveBeenCalledWith(FOLDER, NEW_INDEX);
      expect(mockedEs.discardIndexVersion).not.toHaveBeenCalled();
      expect(mockedEs.deleteAllVideosFromFolder).not.toHaveBeenCalled();
      expect(mockedEs.indexVideo).not.toHaveBeenCalled();

      const videos = bulkIndexedVideos();
      expect(videos).toHaveLength(2);
      expect(videos[0]).toMatchObject({
        uploadDate: '20231201',
        viewCount: 1000,
        likeCount: 50,
        channelName: 'Test Channel',
      });
    });

    it('stores flattened documents (commentsText) instead of comment arrays', async () => {
      mockFolder(['a.info.json', 'a.mp4', 'a.webp'], {
        title: 'A',
        comments: [
          { id: '1', text: 'first' },
          { id: '2', text: 'second' },
        ],
      });

      await loadVideosCache();

      const document = at(bulkIndexedVideos(), 0);
      expect(document).not.toHaveProperty('comments');
      expect(document.commentsText).toBe('first\nsecond');
    });

    it('flushes early when a batch gets heavy', async () => {
      const files: string[] = [];
      for (let i = 0; i < 6; i++) {
        files.push(`v${i}.info.json`, `v${i}.mp4`, `v${i}.webp`);
      }
      // each document is just over a third of the byte budget
      const bigComment = 'x'.repeat(Math.ceil(REINDEX_BATCH_BYTES / 3) + 1);
      mockFolder(files, { title: 'Big', comments: [{ id: '1', text: bigComment }] });

      await loadVideosCache();

      const sizes = mockedEs.bulkIndexDocuments.mock.calls.map(([, documents]) => documents.length);
      expect(sizes).toEqual([3, 3]);
      expect(getReindexStatus().indexed).toBe(6);
    });

    it('keeps a full batch plus one capped document under the cluster request limit', async () => {
      // A batch flushes once it passes REINDEX_BATCH_BYTES, so the largest
      // request is a batch just under that plus the heaviest document a video
      // can make: every text field at its cap, three UTF-8 bytes per character.
      // Elasticsearch refuses a request past http.max_content_length (100 MiB)
      // with a 413, which failed the whole folder's reindex.
      const clusterRequestLimitBytes = 100 * 1024 * 1024;
      const comment = 'x'.repeat(MAX_COMMENTS_CHARS);
      const infoJson = JSON.stringify({
        title: 'Heavy',
        comments: [1, 2, 3].map((n) => ({ id: String(n), text: comment })),
      });
      const vtt = `WEBVTT\n\n00:00:01.000 --> 00:00:04.000\n${'y'.repeat(MAX_TRANSCRIPT_CHARS + 1)}`;
      mockFolder(['a.info.json', 'a.mp4', 'a.en.vtt']);
      mockedFs.readFile.mockImplementation(async (filePath: unknown) =>
        String(filePath).endsWith('.vtt') ? vtt : infoJson,
      );

      await loadVideosCache();

      const document = at(bulkIndexedVideos(), 0);
      expect(document.transcriptText).toHaveLength(MAX_TRANSCRIPT_CHARS);
      const worstRequestBytes = (REINDEX_BATCH_BYTES + realEs.estimateDocumentBytes(document)) * 3;
      expect(worstRequestBytes).toBeLessThan(clusterRequestLimitBytes);
    });

    it('promotes only after the last batch was written', async () => {
      const order: string[] = [];
      mockedEs.bulkIndexDocuments.mockImplementation(async (_index, documents) => {
        order.push('bulk');
        return { indexed: documents.length, skipped: 0 };
      });
      mockedEs.promoteIndexVersion.mockImplementation(async () => {
        order.push('promote');
      });
      mockFolder(['a.info.json', 'a.mp4', 'a.webp']);

      await loadVideosCache();

      expect(order).toEqual(['bulk', 'promote']);
    });

    it('keeps a reindex linear in the size of the folder', async () => {
      // Every stem's sidecars were looked up in the whole listing, so a full
      // reindex cost the square of the folder: seconds at a few thousand videos
      const REINDEX_SCAN_BUDGET_MS = 1_000;
      const sidecars = ['.info.json', '.mp4', '.webp', '.description', '.en.vtt', '.pl.vtt'];
      const stems = Array.from({ length: 1_500 }, (_unused, n) => `2024${String(n).padStart(4, '0')}_Video_${n}`);
      mockFolder(stems.flatMap((stem) => sidecars.map((sidecar) => `${stem}${sidecar}`)));
      mockedFs.readFile.mockImplementation(async (filePath: unknown) =>
        String(filePath).endsWith('.vtt')
          ? 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nA line'
          : JSON.stringify({ title: 'Video' }),
      );

      const started = performance.now();
      await loadVideosCache();
      const elapsed = performance.now() - started;

      expect(getReindexStatus()).toMatchObject({ indexed: 1_500, skipped: 0 });
      expect(elapsed).toBeLessThan(REINDEX_SCAN_BUDGET_MS);
    });

    it('splits large folders into batches', async () => {
      const count = REINDEX_BATCH_SIZE * 2 + 3;
      const files: string[] = [];
      for (let i = 0; i < count; i++) {
        const base = `2023${String(i).padStart(4, '0')}_Video`;
        files.push(`${base}.info.json`, `${base}.mp4`, `${base}.webp`);
      }
      mockFolder(files);

      await loadVideosCache();

      const sizes = mockedEs.bulkIndexDocuments.mock.calls.map(([, documents]) => documents.length);
      expect(sizes).toEqual([REINDEX_BATCH_SIZE, REINDEX_BATCH_SIZE, 3]);
      expect(getReindexStatus()).toMatchObject({
        running: false,
        indexed: count,
        skipped: 0,
        filesDone: count,
        filesTotal: count,
        foldersDone: 1,
        foldersTotal: 1,
      });
    });

    it('skips files with invalid JSON and counts them', async () => {
      mockFolder([
        '20231201_TestVideo1.info.json',
        '20231201_TestVideo1.mp4',
        '20231201_TestVideo1.webp',
        '20231115_TestVideo2.info.json',
        '20231115_TestVideo2.mp4',
        '20231115_TestVideo2.webp',
      ]);
      mockedFs.readFile
        .mockResolvedValueOnce('invalid json content')
        .mockResolvedValueOnce(JSON.stringify({ title: 'Test Video 2' }));

      await expect(loadVideosCache()).resolves.not.toThrow();

      const videos = bulkIndexedVideos();
      expect(videos).toHaveLength(1);
      expect(at(videos, 0).title).toBe('Test Video 2');
      expect(getReindexStatus()).toMatchObject({ indexed: 1, skipped: 1, errors: [] });
    });

    it('skips a video without its media file and indexes one without a thumbnail', async () => {
      mockFolder([
        'only_info.info.json',
        'no_thumb.info.json',
        'no_thumb.mp4',
        'complete.info.json',
        'complete.mp4',
        'complete.webp',
      ]);

      await loadVideosCache();

      expect(
        bulkIndexedVideos()
          .map((v) => v.baseName)
          .sort(),
      ).toEqual(['complete', 'no_thumb']);
      expect(getReindexStatus().skipped).toBe(1);
    });

    it('keeps the live version when no video of the folder could be read', async () => {
      // A drive failing its reads mid-run: every info.json errors, every video
      // is skipped, and promoting the empty version deleted the one search used
      mockFolder(['a.info.json', 'a.mp4', 'b.info.json', 'b.mp4', 'b.webp']);
      mockedFs.readFile.mockRejectedValue(Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' }));

      await loadVideosCache();

      expect(mockedEs.promoteIndexVersion).not.toHaveBeenCalled();
      expect(mockedEs.discardIndexVersion).toHaveBeenCalledWith(NEW_INDEX);
      expect(getReindexStatus()).toMatchObject({ indexed: 0, skipped: 2 });
      expect(getReindexStatus().errors).toEqual([
        expect.stringContaining(`Error scanning folder ${FOLDER}: none of its 2 videos could be read`),
      ]);
    });

    it('still publishes a folder whose info.json files have no video beside them', async () => {
      // Sidecars only (a repair that never got the media, or metadata kept on
      // its own): nothing to index, and nothing that failed
      mockFolder(['a.info.json', 'a.webp', 'b.info.json']);

      await loadVideosCache();

      expect(mockedEs.promoteIndexVersion).toHaveBeenCalledWith(FOLDER, NEW_INDEX);
      expect(getReindexStatus()).toMatchObject({ indexed: 0, skipped: 2, errors: [] });
    });

    it('ignores dot files', async () => {
      mockFolder([
        '.DS_Store',
        '.hidden_file',
        '.videos-index.json',
        '20231201_TestVideo1.info.json',
        '20231201_TestVideo1.mp4',
        '20231201_TestVideo1.webp',
      ]);

      await loadVideosCache();

      expect(bulkIndexedVideos()).toHaveLength(1);
    });

    it('does not call Elasticsearch for an empty folder except to publish the empty version', async () => {
      mockFolder(['archive.txt']);

      await loadVideosCache();

      expect(mockedEs.bulkIndexDocuments).not.toHaveBeenCalled();
      expect(mockedEs.promoteIndexVersion).toHaveBeenCalledWith(FOLDER, NEW_INDEX);
    });

    it('records the HTTP status of an Elasticsearch error with an empty message', async () => {
      mockFolder(['a.info.json', 'a.mp4', 'a.webp']);
      const tooLarge = Object.assign(new Error(''), {
        name: 'ResponseError',
        meta: { statusCode: 413 },
      });
      mockedEs.bulkIndexDocuments.mockRejectedValue(tooLarge);

      await loadVideosCache();

      expect(getReindexStatus().errors).toEqual([`Error scanning folder ${FOLDER}: ResponseError (HTTP 413)`]);
    });

    it('discards the new version and keeps going when a folder fails', async () => {
      mockedConfig.getVideosFolderPaths.mockReturnValue(['/broken', '/fine']);
      readdirMock.mockResolvedValue(['a.info.json', 'a.mp4', 'a.webp']);
      mockedFs.readFile.mockResolvedValue(JSON.stringify({ title: 'A' }));
      mockedEs.createIndexVersion.mockResolvedValueOnce('broken_v1').mockResolvedValueOnce('fine_v1');
      mockedEs.bulkIndexDocuments
        .mockRejectedValueOnce(new Error('bulk exploded'))
        .mockResolvedValueOnce({ indexed: 1, skipped: 0 });

      await expect(loadVideosCache()).resolves.toBeUndefined();

      expect(mockedEs.discardIndexVersion).toHaveBeenCalledWith('broken_v1');
      expect(mockedEs.promoteIndexVersion).not.toHaveBeenCalledWith('/broken', expect.anything());
      expect(mockedEs.promoteIndexVersion).toHaveBeenCalledWith('/fine', 'fine_v1');

      const status = getReindexStatus();
      expect(status.running).toBe(false);
      expect(status.foldersDone).toBe(2);
      expect(status.errors).toEqual([expect.stringContaining('bulk exploded')]);
      expect(status.lastError).toContain('/broken');
    });

    it('discards the new version when promoting fails', async () => {
      mockFolder(['a.info.json', 'a.mp4', 'a.webp']);
      mockedEs.promoteIndexVersion.mockRejectedValue(new Error('alias swap failed'));

      await loadVideosCache();

      expect(mockedEs.discardIndexVersion).toHaveBeenCalledWith(NEW_INDEX);
      expect(getReindexStatus().errors).toEqual([expect.stringContaining('alias swap failed')]);
    });

    it('rejects when Elasticsearch is unavailable and leaves status not running', async () => {
      mockedEs.checkElasticsearchConnection.mockResolvedValue(false);
      mockedConfig.getVideosFolderPaths.mockReturnValue([FOLDER]);

      await expect(loadVideosCache()).rejects.toThrow('Elasticsearch is not available');

      expect(mockedEs.createIndexVersion).not.toHaveBeenCalled();
      const status = getReindexStatus();
      expect(status.running).toBe(false);
      expect(status.lastError).toContain('Elasticsearch is not available');
      expect(status.finishedAt).toBeDefined();
    });

    it('refuses to start a second run while one is in progress', async () => {
      mockedConfig.getVideosFolderPaths.mockReturnValue([FOLDER]);
      let release!: (files: string[]) => void;
      readdirMock.mockReturnValue(
        new Promise<string[]>((resolve) => {
          release = resolve;
        }),
      );

      const first = loadVideosCache();
      await new Promise((resolve) => setImmediate(resolve));
      expect(isReindexRunning()).toBe(true);
      expect(getReindexStatus()).toMatchObject({ running: true, foldersTotal: 1 });

      await expect(loadVideosCache()).rejects.toThrow('already running');

      release(['a.info.json', 'a.mp4', 'a.webp']);
      mockedFs.readFile.mockResolvedValue(JSON.stringify({ title: 'A' }));
      await first;

      expect(isReindexRunning()).toBe(false);
      expect(mockedEs.promoteIndexVersion).toHaveBeenCalledTimes(1);
    });

    it('reports the current folder while scanning', async () => {
      mockedConfig.getVideosFolderPaths.mockReturnValue([FOLDER]);
      readdirMock.mockResolvedValue(['a.info.json', 'a.mp4', 'a.webp']);
      mockedFs.readFile.mockResolvedValue(JSON.stringify({ title: 'A' }));
      let seen: string | undefined;
      mockedEs.bulkIndexDocuments.mockImplementation(async (_index, documents) => {
        seen = getReindexStatus().currentFolder;
        return { indexed: documents.length, skipped: 0 };
      });

      await loadVideosCache();

      expect(seen).toBe(FOLDER);
      expect(getReindexStatus().currentFolder).toBeUndefined();
    });
  });

  describe('describeError', () => {
    it('uses the message when present', () => {
      expect(describeError(new Error('boom'))).toBe('boom');
    });

    it('falls back to the error name and adds the HTTP status', () => {
      const error = Object.assign(new Error(''), {
        name: 'ResponseError',
        meta: { statusCode: 413 },
      });
      expect(describeError(error)).toBe('ResponseError (HTTP 413)');
    });

    it('stringifies non-errors', () => {
      expect(describeError('nope')).toBe('nope');
    });
  });

  describe('refreshVideosCache', () => {
    it('runs a full reindex', async () => {
      mockFolder(['a.info.json', 'a.mp4', 'a.webp']);

      await refreshVideosCache();

      expect(mockedEs.createIndexVersion).toHaveBeenCalledWith(FOLDER);
      expect(mockedEs.promoteIndexVersion).toHaveBeenCalledWith(FOLDER, NEW_INDEX);
    });

    it('skips folders whose cache already exists when onlyMissing is set', async () => {
      mockFolder(['a.info.json', 'a.mp4', 'a.webp']);
      mockedEs.listCachedFolders.mockResolvedValue({ folders: new Set([FOLDER]), elasticsearchUp: true });

      await refreshVideosCache({ onlyMissing: true });

      expect(mockedEs.listCachedFolders).toHaveBeenCalledWith([FOLDER]);
      expect(mockedEs.createIndexVersion).not.toHaveBeenCalled();
      expect(mockedEs.promoteIndexVersion).not.toHaveBeenCalled();
    });

    it('reindexes a folder without a cache even when onlyMissing is set', async () => {
      mockFolder(['a.info.json', 'a.mp4', 'a.webp']);
      mockedEs.listCachedFolders.mockResolvedValue({ folders: new Set(), elasticsearchUp: true });

      await refreshVideosCache({ onlyMissing: true });

      expect(mockedEs.createIndexVersion).toHaveBeenCalledWith(FOLDER);
      expect(mockedEs.promoteIndexVersion).toHaveBeenCalledWith(FOLDER, NEW_INDEX);
    });
  });

  describe('indexVideosFromDisk', () => {
    it('indexes the given videos through the folder alias', async () => {
      readdirMock.mockResolvedValue([
        'a.info.json',
        'a.mp4',
        'a.webp',
        'b.info.json',
        'b.mp4',
        'b.webp',
        'c.info.json',
        'c.mp4',
        'c.webp',
      ]);
      mockedFs.readFile.mockImplementation(async (file) =>
        JSON.stringify({ id: String(file).includes('/a.') ? 'id-a' : 'id-b', title: 'T' }),
      );

      const indexed = await indexVideosFromDisk(FOLDER, ['a', 'b']);

      expect(indexed).toBe(2);
      expect(mockedEs.indexVideo).toHaveBeenCalledTimes(2);
      expect(mockedEs.indexVideo.mock.calls.map(([video]) => video.baseName)).toEqual(['a', 'b']);
      expect(at(mockedEs.indexVideo.mock.calls, 0)[0].videoId).toBe('id-a');
      expect(mockedEs.createIndexVersion).not.toHaveBeenCalled();
    });

    it('skips incomplete videos and swallows indexing errors', async () => {
      // b has no media file; a thumbnail alone is no reason to skip any more
      readdirMock.mockResolvedValue(['a.info.json', 'a.mp4', 'a.webp', 'b.info.json', 'b.webp']);
      mockedFs.readFile.mockResolvedValue(JSON.stringify({ title: 'T' }));
      mockedEs.indexVideo.mockRejectedValueOnce(new Error('ES down'));

      const indexed = await indexVideosFromDisk(FOLDER, ['a', 'b']);

      expect(indexed).toBe(0);
      expect(mockedEs.indexVideo).toHaveBeenCalledTimes(1);
    });

    it('returns 0 without touching disk for an empty list', async () => {
      const indexed = await indexVideosFromDisk(FOLDER, []);

      expect(indexed).toBe(0);
      expect(mockedFs.readdir).not.toHaveBeenCalled();
    });

    it('returns 0 when the folder cannot be listed', async () => {
      mockedFs.readdir.mockRejectedValue(new Error('ENOENT'));

      const indexed = await indexVideosFromDisk('/missing', ['a']);

      expect(indexed).toBe(0);
      expect(mockedEs.indexVideo).not.toHaveBeenCalled();
    });

    const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

    it('writes only once a reindex of the folder has swapped in its new version', async () => {
      // Until the swap the alias points at the version the swap deletes, so a
      // write through it meanwhile would be gone with that version
      mockFolder(['a.info.json', 'a.mp4', 'a.webp']);
      let finishBulk: () => void = () => undefined;
      mockedEs.bulkIndexDocuments.mockImplementationOnce(
        (_index, documents) =>
          new Promise<{ indexed: number; skipped: number }>((resolve) => {
            finishBulk = () => resolve({ indexed: documents.length, skipped: 0 });
          }),
      );
      const reindex = loadVideosCache();
      try {
        await vi.waitFor(() => expect(mockedEs.bulkIndexDocuments).toHaveBeenCalled());

        const write = indexVideosFromDisk(FOLDER, ['a']);
        await settle();
        expect(mockedEs.indexVideo).not.toHaveBeenCalled();

        finishBulk();
        await reindex;
        await vi.waitFor(() => expect(mockedEs.indexVideo).toHaveBeenCalled());
        expect(await write).toBe(1);
        expect(at(mockedEs.promoteIndexVersion.mock.invocationCallOrder, 0)).toBeLessThan(
          at(mockedEs.indexVideo.mock.invocationCallOrder, 0),
        );
      } finally {
        // A failed assertion must not leave the reindex running for the next test
        finishBulk();
        await reindex;
      }
    });

    it('releases the writes it held when the rebuild fails', async () => {
      // A failed rebuild is discarded and the alias keeps its version, so the
      // writes that waited go there. Left waiting, every later write, deferred
      // job batch and retry for the folder would hang until the next reindex.
      mockFolder(['a.info.json', 'a.mp4', 'a.webp']);
      let failBulk: () => void = () => undefined;
      mockedEs.bulkIndexDocuments.mockImplementationOnce(
        () =>
          new Promise<{ indexed: number; skipped: number }>((_resolve, reject) => {
            failBulk = () => reject(new Error('bulk refused (HTTP 500)'));
          }),
      );
      const reindex = loadVideosCache();
      try {
        await vi.waitFor(() => expect(mockedEs.bulkIndexDocuments).toHaveBeenCalled());
        const write = indexVideosFromDisk(FOLDER, ['a']);

        failBulk();
        await reindex;

        await vi.waitFor(() => expect(mockedEs.indexVideo).toHaveBeenCalled());
        expect(await write).toBe(1);
        expect(mockedEs.discardIndexVersion).toHaveBeenCalledWith(NEW_INDEX);
        expect(mockedEs.promoteIndexVersion).not.toHaveBeenCalled();
      } finally {
        failBulk();
        await reindex;
      }
    });

    it('lets a write already in flight land before a reindex lists the folder', async () => {
      // On a folder with no alias yet, the write creates and promotes a
      // version of its own, and that promotion deletes every other version:
      // the reindex creates its version only after the write has landed. With
      // an alias the wait changes nothing, since the files are on disk before
      // the write starts and the listing sees them either way.
      mockFolder(['a.info.json', 'a.mp4', 'a.webp']);
      let finishWrite: () => void = () => undefined;
      mockedEs.indexVideo.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishWrite = () => resolve();
          }),
      );
      const write = indexVideosFromDisk(FOLDER, ['a']);
      await vi.waitFor(() => expect(mockedEs.indexVideo).toHaveBeenCalled());
      const reindex = loadVideosCache();
      try {
        await settle();
        expect(mockedEs.createIndexVersion).not.toHaveBeenCalled();

        finishWrite();
        expect(await write).toBe(1);
        await reindex;
        expect(mockedEs.promoteIndexVersion).toHaveBeenCalledWith(FOLDER, NEW_INDEX);
      } finally {
        finishWrite();
        await reindex;
      }
    });
  });
});
