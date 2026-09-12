import {
  buildVideoItem,
  describeError,
  getReindexStatus,
  getVideos,
  indexVideosFromDisk,
  isReindexRunning,
  loadVideosCache,
  refreshVideosCache,
  REINDEX_BATCH_BYTES,
  REINDEX_BATCH_SIZE,
} from './videoScanner';
import * as fs from 'fs/promises';
import * as config from '../config';
import * as elasticsearchService from './elasticsearchService';
import type { VideoDocument } from './elasticsearchService';
import { at } from '../test-utils';

jest.mock('fs/promises');
jest.mock('../config');
jest.mock('./elasticsearchService', () => {
  const actual = jest.requireActual('./elasticsearchService');
  return {
    ...jest.createMockFromModule<typeof import('./elasticsearchService')>('./elasticsearchService'),
    // pure helpers keep their real implementation
    toDocument: actual.toDocument,
    fromDocument: actual.fromDocument,
    estimateDocumentBytes: actual.estimateDocumentBytes,
  };
});

const mockedFs = fs as jest.Mocked<typeof fs>;
/** The scanner only uses the `readdir(path) → string[]` overload */
const readdirMock = mockedFs.readdir as unknown as jest.Mock<Promise<string[]>, [string]>;
const mockedConfig = config as jest.Mocked<typeof config>;
const mockedEs = elasticsearchService as jest.Mocked<typeof elasticsearchService>;

const FOLDER = '/test/videos';
const NEW_INDEX = 'videos_abc_20250101000000000';

/** All documents passed to bulkIndexDocuments, in order */
function bulkIndexedVideos(): VideoDocument[] {
  return mockedEs.bulkIndexDocuments.mock.calls.flatMap(([, documents]) => documents);
}

function mockFolder(
  files: string[],
  infoJson: Record<string, unknown> = { title: 'Test Video 1' }
) {
  mockedConfig.getVideosFolderPaths.mockReturnValue([FOLDER]);
  readdirMock.mockResolvedValue(files);
  mockedFs.readFile.mockResolvedValue(JSON.stringify(infoJson));
}

describe('videoScanner', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});

    mockedEs.checkElasticsearchConnection.mockResolvedValue(true);
    mockedEs.createIndexVersion.mockResolvedValue(NEW_INDEX);
    mockedEs.bulkIndexDocuments.mockResolvedValue(undefined);
    mockedEs.promoteIndexVersion.mockResolvedValue(undefined);
    mockedEs.discardIndexVersion.mockResolvedValue(undefined);
    mockedEs.indexVideo.mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
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
      mockedEs.searchVideos.mockResolvedValue(mockVideos);

      const result = await getVideos('');
      expect(result.length).toBe(1);
      expect(at(result, 0).title).toBe('Test Video 1');
      expect(at(result, 0).folderPath).toBe(FOLDER);
      expect(mockedEs.searchVideos).toHaveBeenCalledWith('', 'date-desc');
    });

    it('should pass query and sort option through', async () => {
      mockedEs.searchVideos.mockResolvedValue([]);

      await getVideos('test', 'views-desc');
      expect(mockedEs.searchVideos).toHaveBeenCalledWith('test', 'views-desc');
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
      mockedFs.readFile.mockResolvedValue(
        JSON.stringify({
          id: 'abcdefghijk',
          title: 'Test Video 1',
          description: 'Desc',
          upload_date: '20231201',
          view_count: 1000,
          like_count: 50,
          channel: 'Test Channel',
          comments: [{ id: 'c1', text: 'hello' }],
        })
      );

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
      });
      expect(result.video.comments).toHaveLength(1);
      expect(mockedFs.readFile).toHaveBeenCalledWith(
        `${FOLDER}/20231201_TestVideo1.info.json`,
        'utf-8'
      );
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
          })
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

    it('promotes only after the last batch was written', async () => {
      const order: string[] = [];
      mockedEs.bulkIndexDocuments.mockImplementation(async () => {
        order.push('bulk');
      });
      mockedEs.promoteIndexVersion.mockImplementation(async () => {
        order.push('promote');
      });
      mockFolder(['a.info.json', 'a.mp4', 'a.webp']);

      await loadVideosCache();

      expect(order).toEqual(['bulk', 'promote']);
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

    it('skips videos without thumbnail or video file', async () => {
      mockFolder([
        'only_info.info.json',
        'no_thumb.info.json',
        'no_thumb.mp4',
        'complete.info.json',
        'complete.mp4',
        'complete.webp',
      ]);

      await loadVideosCache();

      expect(bulkIndexedVideos().map((v) => v.baseName)).toEqual(['complete']);
      expect(getReindexStatus().skipped).toBe(2);
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

      expect(getReindexStatus().errors).toEqual([
        `Error scanning folder ${FOLDER}: ResponseError (HTTP 413)`,
      ]);
    });

    it('discards the new version and keeps going when a folder fails', async () => {
      mockedConfig.getVideosFolderPaths.mockReturnValue(['/broken', '/fine']);
      readdirMock.mockResolvedValue(['a.info.json', 'a.mp4', 'a.webp']);
      mockedFs.readFile.mockResolvedValue(JSON.stringify({ title: 'A' }));
      mockedEs.createIndexVersion
        .mockResolvedValueOnce('broken_v1')
        .mockResolvedValueOnce('fine_v1');
      mockedEs.bulkIndexDocuments
        .mockRejectedValueOnce(new Error('bulk exploded'))
        .mockResolvedValueOnce(undefined);

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
        })
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
      mockedEs.bulkIndexDocuments.mockImplementation(async () => {
        seen = getReindexStatus().currentFolder;
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
        JSON.stringify({ id: String(file).includes('/a.') ? 'id-a' : 'id-b', title: 'T' })
      );

      const indexed = await indexVideosFromDisk(FOLDER, ['a', 'b']);

      expect(indexed).toBe(2);
      expect(mockedEs.indexVideo).toHaveBeenCalledTimes(2);
      expect(mockedEs.indexVideo.mock.calls.map(([video]) => video.baseName)).toEqual(['a', 'b']);
      expect(at(mockedEs.indexVideo.mock.calls, 0)[0].videoId).toBe('id-a');
      expect(mockedEs.createIndexVersion).not.toHaveBeenCalled();
    });

    it('skips incomplete videos and swallows indexing errors', async () => {
      readdirMock.mockResolvedValue(['a.info.json', 'a.mp4', 'a.webp', 'b.info.json', 'b.mp4']);
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
  });
});
