import request from 'supertest';
import express from 'express';
import os from 'os';
import { EventEmitter } from 'events';
import type { IncomingMessage } from 'http';
import * as fs from 'fs/promises';
import { spawn } from 'child_process';
import { createFolderRouter } from './folder';
import { extractYoutubeVideoId } from '@shared/youtube';
import { errorHandler } from '../app';
import {
  ClearFinishedResponseSchema,
  EnqueueJobsResponseSchema,
  FolderListResponseSchema,
  QueueListResponseSchema,
  QueuePauseResponseSchema,
  StatusResponseSchema,
  VideoDownloadedResponseSchema,
} from '@shared/schemas';
import { createApp as createRealApp } from '../app';
import { getVideosFolderPaths } from '../config';
import {
  findEntryByVideoId,
  getDownloadStatuses,
  loadIndex,
  rebuildIndex,
} from '../services/folderIndex';
import { downloadQueue } from '../services/downloadQueue';
import type { SpawnedProcess } from '../services/downloadQueue';
import {
  DEFAULT_DOWNLOAD_OPTIONS,
  invalidateCategoryCache,
  loadDownloadOptions,
  readFolderConfig,
} from '../services/folderConfig';
import { listCachedFolders } from '../services/elasticsearchService';
import { at } from '../test-utils';

jest.mock('fs/promises');
jest.mock('child_process');
jest.mock('../config', () => {
  const actual = jest.requireActual('../config');
  return { ...actual, getVideosFolderPaths: jest.fn() };
});
jest.mock('../services/folderIndex');
jest.mock('../services/elasticsearchService', () => ({
  listCachedFolders: jest.fn(),
}));
jest.mock('../services/folderConfig', () => {
  const actual = jest.requireActual('../services/folderConfig');
  return {
    ...actual,
    readFolderConfig: jest.fn(),
    loadDownloadOptions: jest.fn(),
    invalidateCategoryCache: jest.fn(),
  };
});

/** yt-dlp process handed to the queue by the fake spawn below (a `SpawnedProcess`) */
interface FakeSpawnedProcess extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: jest.Mock<boolean, [signal?: NodeJS.Signals]>;
}

interface SpawnCall {
  args: string[];
  cwd: string;
  process: FakeSpawnedProcess;
}

// Real queue with a fake spawn so that route <-> queue integration is exercised.
jest.mock('../services/downloadQueue', () => {
  const actual = jest.requireActual<typeof import('../services/downloadQueue')>(
    '../services/downloadQueue'
  );
  const { EventEmitter: EE } = jest.requireActual<typeof import('events')>('events');
  const calls: SpawnCall[] = [];
  const spawnFn = (_cmd: string, args: string[], options: { cwd: string }): SpawnedProcess => {
    const proc: FakeSpawnedProcess = Object.assign(new EE(), {
      stdout: new EE(),
      stderr: new EE(),
      kill: jest.fn(() => {
        setImmediate(() => proc.emit('close', null));
        return true;
      }),
    });
    calls.push({ args, cwd: options.cwd, process: proc });
    return proc;
  };
  return {
    ...actual,
    downloadQueue: new actual.DownloadQueue({
      maxConcurrent: 2,
      // One attempt: the SSE tests fail a process and expect the error
      // event right away, not after a retry backoff
      maxAttempts: 1,
      spawnFn,
      afterJob: async () => {},
    }),
    __spawnCalls: calls,
  };
});

const { __spawnCalls: spawnCalls } = jest.requireMock<{ __spawnCalls: SpawnCall[] }>(
  '../services/downloadQueue'
);

const mockedFs = fs as jest.Mocked<typeof fs>;
const mockedSpawn = spawn as jest.MockedFunction<typeof spawn>;
const mockedGetVideosFolderPaths = getVideosFolderPaths as jest.MockedFunction<
  typeof getVideosFolderPaths
>;
const mockedFindEntry = findEntryByVideoId as jest.MockedFunction<typeof findEntryByVideoId>;
const mockedLoadIndex = loadIndex as jest.MockedFunction<typeof loadIndex>;
const mockedGetDownloadStatuses = getDownloadStatuses as jest.MockedFunction<
  typeof getDownloadStatuses
>;
const mockedRebuildIndex = rebuildIndex as jest.MockedFunction<typeof rebuildIndex>;
const mockedReadFolderConfig = readFolderConfig as jest.MockedFunction<typeof readFolderConfig>;
const mockedLoadDownloadOptions = loadDownloadOptions as jest.MockedFunction<
  typeof loadDownloadOptions
>;
const mockedListCachedFolders = listCachedFolders as jest.MockedFunction<typeof listCachedFolders>;

const FOLDER = '/videos/channel-a';
const OTHER_FOLDER = '/videos/channel-b';

const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createFolderRouter());
  app.use(errorHandler);
  return app;
}

describe('extractYoutubeVideoId', () => {
  it('handles watch, short, shorts and embed URLs', () => {
    expect(extractYoutubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10')).toBe(
      'dQw4w9WgXcQ'
    );
    expect(extractYoutubeVideoId('https://youtu.be/dQw4w9WgXcQ?si=x')).toBe('dQw4w9WgXcQ');
    expect(extractYoutubeVideoId('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(extractYoutubeVideoId('https://www.youtube.com/embed/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });

  it('returns null for unknown shapes', () => {
    expect(extractYoutubeVideoId('https://www.youtube.com/@channel/videos')).toBeNull();
    expect(extractYoutubeVideoId('not a url')).toBeNull();
  });

  it('returns null for ids that are not 11 characters', () => {
    expect(extractYoutubeVideoId('https://www.youtube.com/watch?v=abc123')).toBeNull();
    expect(extractYoutubeVideoId('https://youtu.be/short')).toBeNull();
  });

  it('only extracts ids from real YouTube hosts (SSRF guard)', () => {
    expect(extractYoutubeVideoId('https://evil.example.com/watch?v=dQw4w9WgXcQ')).toBeNull();
    expect(extractYoutubeVideoId('https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ')).toBeNull();
    expect(extractYoutubeVideoId('http://169.254.169.254/latest/meta-data')).toBeNull();
    expect(extractYoutubeVideoId('file:///etc/passwd')).toBeNull();
    expect(extractYoutubeVideoId('https://m.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(extractYoutubeVideoId('https://music.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(
      'dQw4w9WgXcQ'
    );
  });
});

describe('folder router', () => {
  let app: express.Application;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    mockedGetVideosFolderPaths.mockReturnValue([FOLDER, OTHER_FOLDER]);
    mockedFs.mkdir.mockResolvedValue(undefined);
    mockedFs.writeFile.mockResolvedValue(undefined);
    mockedReadFolderConfig.mockResolvedValue(null);
    mockedLoadDownloadOptions.mockResolvedValue({ ...DEFAULT_DOWNLOAD_OPTIONS });
    mockedListCachedFolders.mockResolvedValue(new Set([FOLDER]));
    downloadQueue.clear();
    spawnCalls.length = 0;
    app = createApp();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('GET /api/status', () => {
    it('returns folders with their configs (null when config.json is missing) and defaults', async () => {
      mockedReadFolderConfig.mockImplementation(async (folder) =>
        folder === FOLDER ? { channelUrl: 'https://yt/@a', maxHeight: 1080 } : null
      );

      const response = await request(app).get('/api/status');

      expect(response.status).toBe(200);
      expect(StatusResponseSchema.parse(response.body)).toEqual({
        videosFolderPath: [FOLDER, OTHER_FOLDER],
        folderConfigs: {
          [FOLDER]: { channelUrl: 'https://yt/@a', maxHeight: 1080 },
          [OTHER_FOLDER]: null,
        },
        downloadDefaults: {
          maxHeight: 2160,
          subLangs: ['en'],
          writeComments: true,
          extraArgs: [],
        },
        indexedFolders: [FOLDER],
        listExists: { [FOLDER]: true, [OTHER_FOLDER]: true },
        status: 'ok',
      });
      expect(mockedListCachedFolders).toHaveBeenCalledWith([FOLDER, OTHER_FOLDER]);
    });
  });

  describe('PUT /api/folder/config', () => {
    it('validates input', async () => {
      expect((await request(app).put('/api/folder/config').send({ config: {} })).status).toBe(400);
      expect(
        (await request(app).put('/api/folder/config').send({ folderPath: FOLDER })).status
      ).toBe(400);
      expect(
        (await request(app).put('/api/folder/config').send({ folderPath: '/nope', config: {} }))
          .status
      ).toBe(403);
      expect(
        (
          await request(app)
            .put('/api/folder/config')
            .send({ folderPath: FOLDER, config: { channelUrl: 42 } })
        ).status
      ).toBe(400);
    });

    it('validates download options', async () => {
      const put = (config: unknown) =>
        request(app).put('/api/folder/config').send({ folderPath: FOLDER, config });

      expect((await put({ maxHeight: 100 })).body.error).toMatch(/maxHeight/);
      expect((await put({ subLangs: 'en' })).body.error).toMatch(/subLangs/);
      expect((await put({ writeComments: 'yes' })).body.error).toMatch(/writeComments/);
      expect(mockedFs.writeFile).not.toHaveBeenCalled();
    });

    it('writes config.json with download options', async () => {
      const config = {
        channelUrl: 'https://yt/@a',
        maxHeight: 1080,
        subLangs: ['pl', 'en'],
        writeComments: false,
      };

      const response = await request(app)
        .put('/api/folder/config')
        .send({ folderPath: FOLDER, config });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ success: true, config });
      expect(mockedFs.writeFile).toHaveBeenCalledWith(
        `${FOLDER}/config.json`,
        JSON.stringify(config, null, 2),
        'utf-8'
      );
    });

    it('stores the category trimmed and drops the category cache', async () => {
      const response = await request(app)
        .put('/api/folder/config')
        .send({ folderPath: FOLDER, config: { channelUrl: 'https://yt/@a', category: '  fpv ' } });

      expect(response.status).toBe(200);
      expect(response.body.config).toEqual({ channelUrl: 'https://yt/@a', category: 'fpv' });
      expect(mockedFs.writeFile).toHaveBeenCalledWith(
        `${FOLDER}/config.json`,
        JSON.stringify({ channelUrl: 'https://yt/@a', category: 'fpv' }, null, 2),
        'utf-8'
      );
      expect(invalidateCategoryCache).toHaveBeenCalledTimes(1);
    });

    it('rejects an invalid category before touching the disk', async () => {
      const response = await request(app)
        .put('/api/folder/config')
        .send({ folderPath: FOLDER, config: { category: '   ' } });

      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/category/);
      expect(mockedFs.writeFile).not.toHaveBeenCalled();
      expect(invalidateCategoryCache).not.toHaveBeenCalled();
    });

    it('writes config.json', async () => {
      const config = { channelUrl: 'https://yt/@a' };

      const response = await request(app)
        .put('/api/folder/config')
        .send({ folderPath: FOLDER, config });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ success: true, config });
      expect(mockedFs.writeFile).toHaveBeenCalledWith(
        `${FOLDER}/config.json`,
        JSON.stringify(config, null, 2),
        'utf-8'
      );
    });
  });

  describe('GET /api/folder/list-exists', () => {
    it('reports whether list.json exists', async () => {
      mockedFs.access.mockResolvedValueOnce(undefined);
      expect(
        (await request(app).get('/api/folder/list-exists').query({ folderPath: FOLDER })).body
      ).toEqual({
        exists: true,
      });

      mockedFs.access.mockRejectedValueOnce(enoent());
      expect(
        (await request(app).get('/api/folder/list-exists').query({ folderPath: FOLDER })).body
      ).toEqual({
        exists: false,
      });
    });

    it('rejects missing or disallowed folders', async () => {
      expect((await request(app).get('/api/folder/list-exists')).status).toBe(400);
      expect(
        (await request(app).get('/api/folder/list-exists').query({ folderPath: '/x' })).status
      ).toBe(403);
    });

    it('echoes the rejected value in the 403 body', async () => {
      const response = await request(app)
        .get('/api/folder/list-exists')
        .query({ folderPath: '/x' });

      expect(response.status).toBe(403);
      expect(response.body.error).toBe('Folder path is not in the allowed list: /x');
    });

    it('accepts a folder path with a trailing slash', async () => {
      const response = await request(app)
        .get('/api/folder/list-exists')
        .query({ folderPath: `${FOLDER}/` });

      expect(response.status).toBe(200);
    });

    it('accepts a folder path written with ~/', async () => {
      jest.spyOn(os, 'homedir').mockReturnValue('/videos');

      const response = await request(app)
        .get('/api/folder/list-exists')
        .query({ folderPath: '~/channel-a' });

      expect(response.status).toBe(200);
    });
  });

  describe('GET /api/folder/list', () => {
    const list = [
      { id: 'v1', title: 'One', url: 'https://yt/watch?v=v1' },
      { id: 'v2', title: 'Two', webpage_url: 'https://yt/watch?v=v2' },
    ];

    it('returns videos with statuses coming from the folder index', async () => {
      mockedFs.readFile.mockResolvedValue(JSON.stringify(list));
      mockedGetDownloadStatuses.mockResolvedValue({
        downloadStatuses: { v1: true },
        lastUpdatedDates: { v1: '2024-01-01T00:00:00.000Z' },
      });

      const response = await request(app).get('/api/folder/list').query({ folderPath: FOLDER });

      expect(response.status).toBe(200);
      expect(FolderListResponseSchema.parse(response.body)).toEqual({
        videos: [
          { id: 'v1', title: 'One', url: 'https://yt/watch?v=v1' },
          { id: 'v2', title: 'Two', url: 'https://yt/watch?v=v2' },
        ],
        downloadStatuses: { v1: true },
        lastUpdatedDates: { v1: '2024-01-01T00:00:00.000Z' },
      });
      expect(mockedGetDownloadStatuses).toHaveBeenCalledWith(FOLDER);
    });

    it('maps a real yt-dlp list.json fixture', async () => {
      const realFs = jest.requireActual('fs/promises') as typeof import('fs/promises');
      const fixture = await realFs.readFile(
        `${__dirname}/../test/fixtures/ytdlp-list.json`,
        'utf-8'
      );
      mockedFs.readFile.mockResolvedValue(fixture);
      mockedGetDownloadStatuses.mockResolvedValue({
        downloadStatuses: {},
        lastUpdatedDates: {},
      });

      const response = await request(app).get('/api/folder/list').query({ folderPath: FOLDER });

      expect(response.status).toBe(200);
      expect(response.body.videos).toEqual([
        {
          id: 'yf__frUKreI',
          title: 'Walksnail Ascent Firmware Update How-To',
          url: 'https://www.youtube.com/watch?v=yf__frUKreI',
        },
        {
          id: 'abc123def45',
          title: 'Another video',
          url: 'https://www.youtube.com/watch?v=abc123def45',
        },
      ]);
    });

    it('returns 404 when list.json does not exist', async () => {
      mockedFs.readFile.mockRejectedValue(enoent());

      const response = await request(app).get('/api/folder/list').query({ folderPath: FOLDER });

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('list.json not found');
    });

    it('returns 400 when list.json is not an array', async () => {
      mockedFs.readFile.mockResolvedValue(JSON.stringify({ nope: true }));

      const response = await request(app).get('/api/folder/list').query({ folderPath: FOLDER });

      expect(response.status).toBe(400);
    });

    it('degrades to empty statuses when the index cannot be built', async () => {
      mockedFs.readFile.mockResolvedValue(JSON.stringify(list));
      mockedGetDownloadStatuses.mockRejectedValue(new Error('disk gone'));

      const response = await request(app).get('/api/folder/list').query({ folderPath: FOLDER });

      expect(response.status).toBe(200);
      expect(response.body.downloadStatuses).toEqual({});
      expect(response.body.lastUpdatedDates).toEqual({});
    });
  });

  describe('POST /api/folder/rebuild-index', () => {
    it('rebuilds and reports the entry count', async () => {
      mockedRebuildIndex.mockResolvedValue({
        version: 1,
        builtAt: '2024-01-01T00:00:00.000Z',
        entries: { a: { baseName: 'a', videoFile: 'a.mp4', infoMtime: 'x' } },
      });

      const response = await request(app)
        .post('/api/folder/rebuild-index')
        .send({ folderPath: FOLDER });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        success: true,
        count: 1,
        builtAt: '2024-01-01T00:00:00.000Z',
      });
      expect(mockedRebuildIndex).toHaveBeenCalledWith(FOLDER);
    });
  });

  describe('POST /api/folder/download-playlist', () => {
    function fakeYtDlp(stdout: string, code = 0) {
      mockedSpawn.mockImplementation((() => {
        const proc = Object.assign(new EventEmitter(), {
          stdout: new EventEmitter(),
          stderr: new EventEmitter(),
        });
        // emit after the caller attached its listeners
        setImmediate(() => {
          if (stdout) proc.stdout.emit('data', Buffer.from(stdout));
          if (code !== 0) proc.stderr.emit('data', Buffer.from('boom'));
          proc.emit('close', code);
        });
        return proc;
      }) as unknown as typeof spawn);
    }

    it('returns 404 when config.json is missing', async () => {
      mockedReadFolderConfig.mockResolvedValue(null);

      const response = await request(app)
        .post('/api/folder/download-playlist')
        .send({ folderPath: FOLDER });

      expect(response.status).toBe(404);
    });

    it('returns 400 when channelUrl is not configured', async () => {
      mockedReadFolderConfig.mockResolvedValue({});

      const response = await request(app)
        .post('/api/folder/download-playlist')
        .send({ folderPath: FOLDER });

      expect(response.status).toBe(400);
    });

    it('runs yt-dlp without a shell, appends /videos and stores NDJSON as an array', async () => {
      mockedReadFolderConfig.mockResolvedValue({ channelUrl: 'https://www.youtube.com/@a' });
      fakeYtDlp('{"id":"v1","title":"One"}\n{"id":"v2","title":"Two"}\n');

      const response = await request(app)
        .post('/api/folder/download-playlist')
        .send({ folderPath: FOLDER });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        success: true,
        videoCount: 2,
        listPath: `${FOLDER}/list.json`,
      });
      expect(mockedSpawn).toHaveBeenCalledWith(
        'yt-dlp',
        ['--flat-playlist', '-j', 'https://www.youtube.com/@a/videos'],
        { cwd: FOLDER }
      );
      expect(mockedFs.writeFile).toHaveBeenCalledWith(
        `${FOLDER}/list.json`,
        JSON.stringify(
          [
            { id: 'v1', title: 'One' },
            { id: 'v2', title: 'Two' },
          ],
          null,
          2
        ),
        'utf-8'
      );
    });

    it('returns 500 when yt-dlp fails', async () => {
      mockedReadFolderConfig.mockResolvedValue({ channelUrl: 'https://www.youtube.com/@a/videos' });
      fakeYtDlp('', 1);

      const response = await request(app)
        .post('/api/folder/download-playlist')
        .send({ folderPath: FOLDER });

      expect(response.status).toBe(500);
      expect(response.body.message).toMatch(/exited with code 1/);
      expect(mockedFs.writeFile).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/folder/video-downloaded', () => {
    it('answers from the folder index', async () => {
      mockedFindEntry.mockResolvedValueOnce({ baseName: 'x', videoFile: 'x.mp4', infoMtime: 'm' });
      expect(
        VideoDownloadedResponseSchema.parse(
          (
            await request(app)
              .get('/api/folder/video-downloaded')
              .query({ folderPath: FOLDER, videoId: 'v1' })
          ).body
        )
      ).toEqual({ downloaded: true });

      mockedFindEntry.mockResolvedValueOnce(null);
      expect(
        (
          await request(app)
            .get('/api/folder/video-downloaded')
            .query({ folderPath: FOLDER, videoId: 'v2' })
        ).body
      ).toEqual({ downloaded: false });
    });

    it('requires videoId', async () => {
      const response = await request(app)
        .get('/api/folder/video-downloaded')
        .query({ folderPath: FOLDER });
      expect(response.status).toBe(400);
    });
  });

  describe('queue endpoints', () => {
    it('validates enqueue input', async () => {
      expect(
        (
          await request(app)
            .post('/api/folder/queue')
            .send({ folderPath: '/x', type: 'download', videos: [] })
        ).status
      ).toBe(403);
      expect(
        (
          await request(app)
            .post('/api/folder/queue')
            .send({ folderPath: FOLDER, type: 'nope', videos: [{}] })
        ).status
      ).toBe(400);
      expect(
        (
          await request(app)
            .post('/api/folder/queue')
            .send({ folderPath: FOLDER, type: 'download', videos: [] })
        ).status
      ).toBe(400);
    });

    it('enqueues download jobs, deriving ids and urls when needed', async () => {
      const response = await request(app)
        .post('/api/folder/queue')
        .send({
          folderPath: FOLDER,
          type: 'download',
          videos: [
            { videoId: 'aaaaaaaaaaa', title: 'One' },
            { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
            { title: 'no id' },
          ],
        });

      expect(response.status).toBe(202);
      expect(EnqueueJobsResponseSchema.parse(response.body).jobs).toHaveLength(2);
      expect(response.body.jobs[0]).toMatchObject({
        videoId: 'aaaaaaaaaaa',
        videoUrl: 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
        type: 'download',
        status: 'running',
        folderPath: FOLDER,
      });
      expect(response.body.jobs[1]).toMatchObject({ videoId: 'dQw4w9WgXcQ', status: 'queued' });
      expect(response.body.skipped).toEqual([
        { videoId: '', reason: 'videoId or videoUrl is required' },
      ]);
      expect(at(spawnCalls, 0).cwd).toBe(FOLDER);
      expect(at(spawnCalls, 0).args).toContain('--download-archive');
    });

    it('canonicalizes URLs carrying playlist context (yt-dlp would walk the whole playlist)', async () => {
      const response = await request(app)
        .post('/api/folder/queue')
        .send({
          folderPath: FOLDER,
          type: 'download',
          videos: [
            {
              url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLDxp123&index=111',
            },
          ],
        });

      expect(response.status).toBe(202);
      expect(response.body.jobs[0]).toMatchObject({
        videoId: 'dQw4w9WgXcQ',
        videoUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      });
      const args = at(spawnCalls, 0).args;
      expect(args).toContain('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
      expect(args.join(' ')).not.toContain('list=');
    });

    it('refuses video URLs that are not YouTube (SSRF guard)', async () => {
      const response = await request(app)
        .post('/api/folder/queue')
        .send({
          folderPath: FOLDER,
          type: 'download',
          videos: [
            { videoUrl: 'file:///etc/passwd' },
            { videoUrl: 'http://169.254.169.254/latest/meta-data' },
            { videoUrl: 'https://evil.example.com/watch?v=dQw4w9WgXcQ' },
            { videoId: 'not-a-valid-id' },
          ],
        });

      expect(response.status).toBe(202);
      expect(response.body.jobs).toHaveLength(0);
      expect(response.body.skipped).toEqual([
        { videoId: '', reason: 'videoUrl must be a YouTube video URL' },
        { videoId: '', reason: 'videoUrl must be a YouTube video URL' },
        { videoId: '', reason: 'videoUrl must be a YouTube video URL' },
        { videoId: 'not-a-valid-id', reason: 'videoId is not a valid YouTube video id' },
      ]);
      expect(spawnCalls).toHaveLength(0);
    });

    it('applies the folder download options to enqueued jobs', async () => {
      mockedLoadDownloadOptions.mockResolvedValue({
        maxHeight: 1080,
        subLangs: ['pl'],
        writeComments: false,
      });

      const response = await request(app)
        .post('/api/folder/queue')
        .send({ folderPath: FOLDER, type: 'download', videos: [{ videoId: 'aaaaaaaaaaa' }] });

      expect(response.status).toBe(202);
      expect(mockedLoadDownloadOptions).toHaveBeenCalledWith(FOLDER);
      expect(response.body.jobs[0].options).toEqual({
        maxHeight: 1080,
        subLangs: ['pl'],
        writeComments: false,
      });
      const args = at(spawnCalls, 0).args;
      expect(args[args.indexOf('-f') + 1]).toContain('height<=1080');
      expect(args[args.indexOf('--sub-lang') + 1]).toBe('pl');
      expect(args).not.toContain('--write-comments');
    });

    it('enqueues update jobs pinned to the existing stem and skips non-downloaded videos', async () => {
      mockedLoadIndex.mockResolvedValue({
        version: 1,
        builtAt: 'now',
        entries: {
          aaaaaaaaaaa: { baseName: '20240101_Old_Name', videoFile: 'x.mp4', infoMtime: 'm' },
        },
      });

      const response = await request(app)
        .post('/api/folder/queue')
        .send({
          folderPath: FOLDER,
          type: 'update',
          videos: [{ videoId: 'aaaaaaaaaaa' }, { videoId: 'iiiiiiiiiii' }],
        });

      expect(response.status).toBe(202);
      expect(response.body.jobs).toHaveLength(1);
      expect(response.body.jobs[0]).toMatchObject({
        videoId: 'aaaaaaaaaaa',
        type: 'update',
        baseName: '20240101_Old_Name',
      });
      expect(response.body.skipped).toEqual([{ videoId: 'iiiiiiiiiii', reason: 'not downloaded' }]);
      expect(at(spawnCalls, 0).args).toContain('--skip-download');
      expect(at(spawnCalls, 0).args).toContain('20240101_Old_Name.%(ext)s');
    });

    it('lists jobs, optionally filtered by folder', async () => {
      await request(app)
        .post('/api/folder/queue')
        .send({ folderPath: FOLDER, type: 'download', videos: [{ videoId: 'aaaaaaaaaaa' }] });
      await request(app)
        .post('/api/folder/queue')
        .send({ folderPath: OTHER_FOLDER, type: 'download', videos: [{ videoId: 'bbbbbbbbbbb' }] });

      const all = await request(app).get('/api/folder/queue');
      expect(all.body.jobs.map((j: { videoId: string }) => j.videoId)).toEqual([
        'aaaaaaaaaaa',
        'bbbbbbbbbbb',
      ]);

      const filtered = await request(app)
        .get('/api/folder/queue')
        .query({ folderPath: OTHER_FOLDER });
      expect(filtered.body.jobs.map((j: { videoId: string }) => j.videoId)).toEqual([
        'bbbbbbbbbbb',
      ]);
    });

    it('cancels a single job and all jobs of a folder', async () => {
      const enqueued = await request(app)
        .post('/api/folder/queue')
        .send({
          folderPath: FOLDER,
          type: 'download',
          videos: [
            { videoId: 'aaaaaaaaaaa' },
            { videoId: 'bbbbbbbbbbb' },
            { videoId: 'ccccccccccc' },
          ],
        });
      const [running, queued] = enqueued.body.jobs;

      const single = await request(app).delete(`/api/folder/queue/${queued.id}`);
      expect(single.status).toBe(200);
      expect(single.body).toMatchObject({ cancelled: true, job: { status: 'cancelled' } });

      expect((await request(app).delete('/api/folder/queue/unknown')).status).toBe(404);

      const all = await request(app).delete('/api/folder/queue').query({ folderPath: FOLDER });
      expect(all.body).toEqual({ cancelled: 2 });
      expect(at(spawnCalls, 0).process.kill).toHaveBeenCalled();
      await flush();
      expect(downloadQueue.get(running.id)?.status).toBe('cancelled');
    });

    it('pauses and resumes the queue', async () => {
      let response = await request(app).post('/api/folder/queue/pause?paused=1');
      expect(response.status).toBe(200);
      expect(QueuePauseResponseSchema.parse(response.body)).toEqual({ paused: true });

      const pausedList = await request(app).get('/api/folder/queue');
      expect(QueueListResponseSchema.parse(pausedList.body).paused).toBe(true);

      response = await request(app).post('/api/folder/queue/resume?paused=0');
      expect(response.body).toEqual({ paused: false });

      const bad = await request(app).post('/api/folder/queue/pause?paused=banana');
      expect(bad.status).toBe(400);
    });

    it('clears the finished jobs the queue keeps in memory', async () => {
      await request(app)
        .post('/api/folder/queue')
        .send({
          folderPath: FOLDER,
          type: 'download',
          videos: [{ videoId: 'aaaaaaaaaaa' }, { videoId: 'bbbbbbbbbbb' }],
        });
      await request(app).delete('/api/folder/queue').query({ folderPath: FOLDER });
      await flush();

      const cleared = await request(app).delete('/api/folder/queue/finished');
      expect(cleared.status).toBe(200);
      expect(ClearFinishedResponseSchema.parse(cleared.body)).toEqual({ cleared: 2 });

      const list = await request(app).get('/api/folder/queue');
      expect(QueueListResponseSchema.parse(list.body).jobs).toHaveLength(0);
    });
  });

  describe('POST /api/folder/download-video (SSE)', () => {
    const collectStream = (
      res: request.Response,
      callback: (err: Error | null, body: string) => void
    ) => {
      // superagent hands custom parsers the raw http.IncomingMessage
      const stream = res as unknown as IncomingMessage;
      let data = '';
      stream.on('data', (chunk: Buffer) => {
        data += chunk.toString();
      });
      stream.on('end', () => callback(null, data));
    };

    /** supertest requests are lazy — start it and wait until yt-dlp was spawned */
    const startRequest = (test: request.Test) =>
      new Promise<request.Response>((resolve, reject) => {
        test.end((err, res) => (err ? reject(err) : resolve(res)));
      });
    const waitForSpawn = async () => {
      const deadline = Date.now() + 2000;
      while (spawnCalls.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    };

    const parseEvents = (body: string) =>
      body
        .split('\n\n')
        .filter((chunk) => chunk.startsWith('data: '))
        .map((chunk) => JSON.parse(chunk.slice('data: '.length)));

    it('validates input before opening the stream', async () => {
      expect(
        (await request(app).post('/api/folder/download-video').send({ folderPath: FOLDER })).status
      ).toBe(400);
      expect(
        (
          await request(app)
            .post('/api/folder/download-video')
            .send({ folderPath: '/x', videoUrl: 'u' })
        ).status
      ).toBe(403);
    });

    it('rejects a non-YouTube videoUrl before opening the stream (SSRF guard)', async () => {
      const response = await request(app)
        .post('/api/folder/download-video')
        .send({ folderPath: FOLDER, videoUrl: 'file:///etc/passwd' });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'videoUrl must be a YouTube video URL' });
      expect(spawnCalls).toHaveLength(0);
    });

    it('streams start/output/done events for a queued job', async () => {
      const pending = startRequest(
        request(app)
          .post('/api/folder/download-video')
          .send({ folderPath: FOLDER, videoUrl: 'https://www.youtube.com/watch?v=aaaaaaaaaaa' })
          .buffer(true)
          .parse(collectStream)
      );
      await waitForSpawn();

      expect(spawnCalls).toHaveLength(1);
      const { args, process } = at(spawnCalls, 0);
      expect(args).toContain('https://www.youtube.com/watch?v=aaaaaaaaaaa');
      process.stdout.emit('data', Buffer.from('[download] 50.0% of 1MiB\n'));
      process.stdout.emit('data', Buffer.from('[download] 100% of 1MiB\n'));
      process.emit('close', 0);

      const response = await pending;

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/text\/event-stream/);
      const events = parseEvents(response.body as string);
      expect(events[0]).toEqual({ type: 'start', message: 'Starting download...' });
      expect(events.filter((e) => e.type === 'output').map((e) => e.message)).toEqual([
        '[download] 50.0% of 1MiB\n',
        '[download] 100% of 1MiB\n',
      ]);
      expect(events[events.length - 1]).toEqual({
        type: 'done',
        message: 'Download completed successfully',
        done: true,
      });
    });

    it('strips playlist context from the URL before enqueueing', async () => {
      const pending = startRequest(
        request(app)
          .post('/api/folder/download-video')
          .send({
            folderPath: FOLDER,
            videoUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLDxp123&index=111',
          })
          .buffer(true)
          .parse(collectStream)
      );
      await waitForSpawn();

      expect(spawnCalls).toHaveLength(1);
      const { args, process } = at(spawnCalls, 0);
      expect(args).toContain('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
      expect(args.join(' ')).not.toContain('list=');
      process.emit('close', 0);

      await pending;
    });

    it('reports an error event when yt-dlp fails', async () => {
      const pending = startRequest(
        request(app)
          .post('/api/folder/download-video')
          .send({ folderPath: FOLDER, videoUrl: 'https://youtu.be/bbbbbbbbbbb' })
          .buffer(true)
          .parse(collectStream)
      );
      await waitForSpawn();

      expect(spawnCalls).toHaveLength(1);
      at(spawnCalls, 0).process.emit('close', 1);

      const response = await pending;
      const events = parseEvents(response.body as string);

      expect(events[events.length - 1]).toEqual({
        type: 'error',
        error: 'yt-dlp exited with code 1 after 1 attempts',
        done: true,
      });
    });
  });
});

describe('createApp (full app with body limit)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    mockedGetVideosFolderPaths.mockReturnValue([FOLDER]);
    mockedFs.mkdir.mockResolvedValue(undefined);
    mockedLoadDownloadOptions.mockResolvedValue({ ...DEFAULT_DOWNLOAD_OPTIONS });
    downloadQueue.clear();
    spawnCalls.length = 0;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('accepts a bulk enqueue for a channel with thousands of videos', async () => {
    const videos = Array.from({ length: 4000 }, (_, i) => ({
      videoId: `video${String(i).padStart(6, '0')}`,
    }));
    const body = { folderPath: FOLDER, type: 'download', videos };
    // body-parser's default limit is 100 kB — make sure we are well above it
    expect(Buffer.byteLength(JSON.stringify(body))).toBeGreaterThan(100 * 1024);

    const response = await request(createRealApp()).post('/api/folder/queue').send(body);

    expect(response.status).toBe(202);
    expect(response.body.jobs).toHaveLength(4000);
    expect(response.body.skipped).toEqual([]);
  });
});
