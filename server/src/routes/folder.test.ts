import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import os from 'node:os';
import {
  ClearFinishedResponseSchema,
  downloadVideoEventSchema,
  EnqueueJobsResponseSchema,
  FolderListResponseSchema,
  FolderSummariesResponseSchema,
  QueueListResponseSchema,
  QueuePauseResponseSchema,
  StatusResponseSchema,
  VideoDownloadedResponseSchema,
} from '@videodeck/shared/schemas';
import { extractYoutubeVideoId } from '@videodeck/shared/youtube';
import type express from 'express';
import request from 'supertest';
import { createApp as createRealApp } from '../app';
import { getVideosFolderPaths } from '../config';
import { readCollection } from '../services/collection';
import type { SpawnedProcess } from '../services/downloadQueue';
import { downloadQueue } from '../services/downloadQueue';
import { listCachedFolders } from '../services/elasticsearchService';
import {
  DEFAULT_DOWNLOAD_OPTIONS,
  invalidateCategoryCache,
  loadDownloadOptions,
  readFolderConfig,
} from '../services/folderConfig';
import { findEntryByVideoId, getDownloadStatuses, loadIndex, rebuildIndex } from '../services/folderIndex';
import { at } from '../test-utils';
import { activeSseStreamCount } from '../utils/sseRegistry';
import { invalidateStatusCache, invalidateSummaryCache } from './folder';

jest.mock('node:fs/promises');
jest.mock('node:child_process');
jest.mock('../config', () => {
  const actual = jest.requireActual('../config');
  return { ...actual, getVideosFolderPaths: jest.fn() };
});
jest.mock('../services/folderIndex');
jest.mock('../services/collection');
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
  const actual = jest.requireActual<typeof import('../services/downloadQueue')>('../services/downloadQueue');
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
      afterJob: async () => {
        /* tests inject no post-job hook here */
      },
    }),
    __spawnCalls: calls,
  };
});

const { __spawnCalls: spawnCalls } = jest.requireMock<{ __spawnCalls: SpawnCall[] }>('../services/downloadQueue');

const mockedFs = fs as jest.Mocked<typeof fs>;
const mockedSpawn = spawn as jest.MockedFunction<typeof spawn>;
const mockedGetVideosFolderPaths = getVideosFolderPaths as jest.MockedFunction<typeof getVideosFolderPaths>;
const mockedFindEntry = findEntryByVideoId as jest.MockedFunction<typeof findEntryByVideoId>;
const mockedLoadIndex = loadIndex as jest.MockedFunction<typeof loadIndex>;
const mockedGetDownloadStatuses = getDownloadStatuses as jest.MockedFunction<typeof getDownloadStatuses>;
const mockedRebuildIndex = rebuildIndex as jest.MockedFunction<typeof rebuildIndex>;
const mockedReadFolderConfig = readFolderConfig as jest.MockedFunction<typeof readFolderConfig>;
const mockedLoadDownloadOptions = loadDownloadOptions as jest.MockedFunction<typeof loadDownloadOptions>;
const mockedListCachedFolders = listCachedFolders as jest.MockedFunction<typeof listCachedFolders>;
const mockedReadCollection = readCollection as jest.MockedFunction<typeof readCollection>;

const FOLDER = '/videos/channel-a';
const OTHER_FOLDER = '/videos/channel-b';

const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/** File handle handed out by the fs.open mock (writeJsonAtomic) */
const mockFileHandle = {
  writeFile: jest.fn<Promise<void>, [string, BufferEncoding]>(),
  sync: jest.fn<Promise<void>, []>(),
  close: jest.fn<Promise<void>, []>(),
};

/** The real app wiring (host guard, CORS, auth, routers, error handling) */
function createApp() {
  return createRealApp();
}

describe('extractYoutubeVideoId', () => {
  it('handles watch, short, shorts and embed URLs', () => {
    expect(extractYoutubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10')).toBe('dQw4w9WgXcQ');
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
    expect(extractYoutubeVideoId('https://music.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });
});

describe('folder router', () => {
  let app: express.Application;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {
      /* silence expected error logs */
    });
    mockedGetVideosFolderPaths.mockReturnValue([FOLDER, OTHER_FOLDER]);
    mockedFs.mkdir.mockResolvedValue(undefined);
    mockedFs.writeFile.mockResolvedValue(undefined);
    mockedFs.open.mockResolvedValue(mockFileHandle as unknown as import('node:fs/promises').FileHandle);
    mockedFs.rename.mockResolvedValue(undefined);
    mockFileHandle.writeFile.mockResolvedValue(undefined);
    mockFileHandle.sync.mockResolvedValue(undefined);
    mockFileHandle.close.mockResolvedValue(undefined);
    mockedReadFolderConfig.mockResolvedValue(null);
    mockedLoadDownloadOptions.mockResolvedValue({ ...DEFAULT_DOWNLOAD_OPTIONS });
    mockedListCachedFolders.mockResolvedValue({ folders: new Set([FOLDER]), elasticsearchUp: true });
    downloadQueue.clear();
    spawnCalls.length = 0;
    invalidateSummaryCache();
    app = createApp();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('GET /api/status', () => {
    it('returns folders with their configs (null when config.json is missing) and defaults', async () => {
      mockedReadFolderConfig.mockImplementation(async (folder) =>
        folder === FOLDER ? { channelUrl: 'https://www.youtube.com/@a', maxHeight: 1080 } : null,
      );

      const response = await request(app).get('/api/status');

      expect(response.status).toBe(200);
      expect(StatusResponseSchema.parse(response.body)).toEqual({
        videosFolderPath: [FOLDER, OTHER_FOLDER],
        folderConfigs: {
          [FOLDER]: { channelUrl: 'https://www.youtube.com/@a', maxHeight: 1080 },
          [OTHER_FOLDER]: null,
        },
        downloadDefaults: {
          maxHeight: 2160,
          subLangs: ['en'],
          writeComments: true,
          extraArgs: [],
          impersonate: false,
          concurrentFragments: 1,
          sponsorblockRemove: false,
        },
        indexedFolders: [FOLDER],
        listExists: { [FOLDER]: true, [OTHER_FOLDER]: true },
        elasticsearch: 'ok',
        status: 'ok',
      });
      expect(mockedListCachedFolders).toHaveBeenCalledWith([FOLDER, OTHER_FOLDER]);
    });

    it('serves the folders from disk when Elasticsearch is unreachable', async () => {
      invalidateStatusCache();
      mockedListCachedFolders.mockResolvedValue({ folders: new Set(), elasticsearchUp: false });

      const response = await request(app).get('/api/status');

      expect(response.status).toBe(200);
      const body = StatusResponseSchema.parse(response.body);
      // The folder list, the configs and list.json presence all come from disk
      expect(body.videosFolderPath).toEqual([FOLDER, OTHER_FOLDER]);
      expect(body.listExists).toEqual({ [FOLDER]: true, [OTHER_FOLDER]: true });
      // Nothing could be read, so no folder claims to be indexed and the
      // response says why
      expect(body.indexedFolders).toEqual([]);
      expect(body.elasticsearch).toBe('down');
    });
  });

  describe('PUT /api/folder/config', () => {
    it('validates input', async () => {
      expect((await request(app).put('/api/folder/config').send({ config: {} })).status).toBe(400);
      expect((await request(app).put('/api/folder/config').send({ folderPath: FOLDER })).status).toBe(400);
      expect((await request(app).put('/api/folder/config').send({ folderPath: '/nope', config: {} })).status).toBe(403);
      expect(
        (
          await request(app)
            .put('/api/folder/config')
            .send({ folderPath: FOLDER, config: { channelUrl: 42 } })
        ).status,
      ).toBe(400);
    });

    it('validates download options', async () => {
      const put = (config: unknown) => request(app).put('/api/folder/config').send({ folderPath: FOLDER, config });

      expect((await put({ maxHeight: 100 })).body.error).toMatch(/maxHeight/);
      expect((await put({ subLangs: 'en' })).body.error).toMatch(/subLangs/);
      expect((await put({ writeComments: 'yes' })).body.error).toMatch(/writeComments/);
      expect(mockedFs.open).not.toHaveBeenCalled();
    });

    it('writes config.json with download options', async () => {
      const config = {
        channelUrl: 'https://www.youtube.com/@a',
        maxHeight: 1080,
        subLangs: ['pl', 'en'],
        writeComments: false,
      };

      const response = await request(app).put('/api/folder/config').send({ folderPath: FOLDER, config });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ success: true, config });
      expect(mockedFs.open).toHaveBeenCalledWith(
        expect.stringMatching(new RegExp(`^${FOLDER}/config.json..*.tmp$`)),
        'w',
      );
      expect(mockFileHandle.writeFile).toHaveBeenCalledWith(JSON.stringify(config, null, 2), 'utf-8');
      expect(mockedFs.rename).toHaveBeenCalledWith(expect.any(String), `${FOLDER}/config.json`);
    });

    it('stores the category trimmed and drops the category cache', async () => {
      const response = await request(app)
        .put('/api/folder/config')
        .send({ folderPath: FOLDER, config: { channelUrl: 'https://www.youtube.com/@a', category: '  fpv ' } });

      expect(response.status).toBe(200);
      expect(response.body.config).toEqual({ channelUrl: 'https://www.youtube.com/@a', category: 'fpv' });
      expect(mockedFs.open).toHaveBeenCalledWith(expect.stringMatching(/config\.json\..*\.tmp$/), 'w');
      expect(mockFileHandle.writeFile).toHaveBeenCalledWith(
        JSON.stringify({ channelUrl: 'https://www.youtube.com/@a', category: 'fpv' }, null, 2),
        'utf-8',
      );
      expect(invalidateCategoryCache).toHaveBeenCalledTimes(1);
    });

    it('rejects an invalid category before touching the disk', async () => {
      const response = await request(app)
        .put('/api/folder/config')
        .send({ folderPath: FOLDER, config: { category: '   ' } });

      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/category/);
      expect(mockedFs.open).not.toHaveBeenCalled();
      expect(invalidateCategoryCache).not.toHaveBeenCalled();
    });

    it('rejects a channelUrl that is not a YouTube channel URL', async () => {
      const response = await request(app)
        .put('/api/folder/config')
        .send({ folderPath: FOLDER, config: { channelUrl: 'http://169.254.169.254/latest/meta-data' } });

      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/YouTube channel URL/);
      expect(mockedFs.open).not.toHaveBeenCalled();
    });

    it('writes config.json', async () => {
      const config = { channelUrl: 'https://www.youtube.com/@a' };

      const response = await request(app).put('/api/folder/config').send({ folderPath: FOLDER, config });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ success: true, config });
      expect(mockedFs.open).toHaveBeenCalledWith(
        expect.stringMatching(new RegExp(`^${FOLDER}/config.json..*.tmp$`)),
        'w',
      );
      expect(mockFileHandle.writeFile).toHaveBeenCalledWith(JSON.stringify(config, null, 2), 'utf-8');
      expect(mockedFs.rename).toHaveBeenCalledWith(expect.any(String), `${FOLDER}/config.json`);
    });
  });

  describe('GET /api/folder/list-exists', () => {
    it('reports whether list.json exists', async () => {
      mockedFs.access.mockResolvedValueOnce(undefined);
      expect((await request(app).get('/api/folder/list-exists').query({ folderPath: FOLDER })).body).toEqual({
        exists: true,
      });

      mockedFs.access.mockRejectedValueOnce(enoent());
      expect((await request(app).get('/api/folder/list-exists').query({ folderPath: FOLDER })).body).toEqual({
        exists: false,
      });
    });

    it('rejects missing or disallowed folders', async () => {
      expect((await request(app).get('/api/folder/list-exists')).status).toBe(400);
      expect((await request(app).get('/api/folder/list-exists').query({ folderPath: '/x' })).status).toBe(403);
    });

    it('echoes the rejected value in the 403 body', async () => {
      const response = await request(app).get('/api/folder/list-exists').query({ folderPath: '/x' });

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

      const response = await request(app).get('/api/folder/list-exists').query({ folderPath: '~/channel-a' });

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
      const fixture = await realFs.readFile(`${__dirname}/../test/fixtures/ytdlp-list.json`, 'utf-8');
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

    it('serves a collection from its folder index instead of list.json', async () => {
      mockedReadFolderConfig.mockResolvedValue({ kind: 'collection' });
      mockedFs.readFile.mockRejectedValue(enoent());
      mockedReadCollection.mockResolvedValue({
        videos: [{ id: 'v1', title: 'One', url: 'https://www.youtube.com/watch?v=v1' }],
        downloadStatuses: { v1: true },
        lastUpdatedDates: { v1: '2024-01-01T00:00:00.000Z' },
      });

      const response = await request(app).get('/api/folder/list').query({ folderPath: FOLDER });

      expect(response.status).toBe(200);
      expect(FolderListResponseSchema.parse(response.body)).toEqual({
        videos: [{ id: 'v1', title: 'One', url: 'https://www.youtube.com/watch?v=v1' }],
        downloadStatuses: { v1: true },
        lastUpdatedDates: { v1: '2024-01-01T00:00:00.000Z' },
      });
      expect(mockedReadCollection).toHaveBeenCalledWith(FOLDER);
    });
  });

  describe('GET /api/folder/summaries', () => {
    const listPath = (folder: string): string => `${folder}/list.json`;
    const listOf = (ids: string[]): string =>
      JSON.stringify(ids.map((id) => ({ id, title: `Video ${id}`, url: `https://yt/watch?v=${id}` })));

    beforeEach(() => {
      invalidateSummaryCache();
      mockedFs.readFile.mockImplementation((filePath) => {
        const target = String(filePath);
        if (target === listPath(FOLDER)) {
          return Promise.resolve(listOf(['v1', 'v2', 'v3']));
        }
        if (target === listPath(OTHER_FOLDER)) {
          return Promise.resolve(listOf(['w1']));
        }
        return Promise.reject(enoent());
      });
      mockedGetDownloadStatuses.mockImplementation((folderPath) =>
        Promise.resolve(
          folderPath === FOLDER
            ? {
                downloadStatuses: { v1: true, v2: true },
                lastUpdatedDates: {
                  v1: '2026-09-01T00:00:00.000Z',
                  v2: '2020-01-01T00:00:00.000Z',
                },
              }
            : { downloadStatuses: {}, lastUpdatedDates: {} },
        ),
      );
    });

    it('reports one summary per configured folder', async () => {
      const response = await request(app).get('/api/folder/summaries');

      expect(response.status).toBe(200);
      expect(FolderSummariesResponseSchema.parse(response.body)).toEqual({
        summaries: {
          [FOLDER]: {
            videos: 3,
            downloaded: 2,
            notDownloaded: 1,
            stale: 1,
            newestUpdate: '2026-09-01T00:00:00.000Z',
          },
          [OTHER_FOLDER]: { videos: 1, downloaded: 0, notDownloaded: 1, stale: 0 },
        },
      });
    });

    it('reports zeroes for a folder without a readable list.json', async () => {
      mockedFs.readFile.mockRejectedValue(enoent());

      const response = await request(app).get('/api/folder/summaries');

      expect(response.status).toBe(200);
      expect(response.body.summaries).toEqual({
        [FOLDER]: { videos: 0, downloaded: 0, notDownloaded: 0, stale: 0 },
        [OTHER_FOLDER]: { videos: 0, downloaded: 0, notDownloaded: 0, stale: 0 },
      });
    });

    it('reads the folders once for a burst of requests', async () => {
      await request(app).get('/api/folder/summaries');
      const readsAfterFirst = mockedFs.readFile.mock.calls.length;

      await request(app).get('/api/folder/summaries');

      // The console polls this endpoint; the second request inside the cache
      // window must not touch the disks again.
      expect(mockedFs.readFile.mock.calls.length).toBe(readsAfterFirst);
    });

    it('summarizes one folder when asked for it', async () => {
      const response = await request(app).get('/api/folder/summaries').query({ folderPath: OTHER_FOLDER });

      expect(response.status).toBe(200);
      expect(FolderSummariesResponseSchema.parse(response.body)).toEqual({
        summaries: { [OTHER_FOLDER]: { videos: 1, downloaded: 0, notDownloaded: 1, stale: 0 } },
      });
      // Two reads for the one folder, not two per configured folder
      expect(mockedFs.readFile).toHaveBeenCalledTimes(1);
      expect(mockedGetDownloadStatuses).toHaveBeenCalledTimes(1);
      expect(mockedGetDownloadStatuses).toHaveBeenCalledWith(OTHER_FOLDER);
    });

    it('reads one folder fresh and patches it into the cached answer for every folder', async () => {
      // The console asks for one folder right after its job finished, so the
      // answer must come from disk even inside the cache window, and the full
      // answer served next must not roll the folder back to the stale counts.
      await request(app).get('/api/folder/summaries');
      mockedGetDownloadStatuses.mockImplementation((folderPath) =>
        Promise.resolve(
          folderPath === OTHER_FOLDER
            ? { downloadStatuses: { w1: true }, lastUpdatedDates: { w1: '2026-09-20T00:00:00.000Z' } }
            : { downloadStatuses: {}, lastUpdatedDates: {} },
        ),
      );

      const one = await request(app).get('/api/folder/summaries').query({ folderPath: OTHER_FOLDER });
      const all = await request(app).get('/api/folder/summaries');

      const fresh = { videos: 1, downloaded: 1, notDownloaded: 0, stale: 0, newestUpdate: '2026-09-20T00:00:00.000Z' };
      expect(one.body.summaries[OTHER_FOLDER]).toEqual(fresh);
      expect(all.body.summaries[OTHER_FOLDER]).toEqual(fresh);
      expect(all.body.summaries[FOLDER].videos).toBe(3);
    });

    it('counts a collection from its folder index, with nothing left to download', async () => {
      mockedReadFolderConfig.mockImplementation((folderPath) =>
        Promise.resolve(folderPath === OTHER_FOLDER ? { kind: 'collection' } : null),
      );
      mockedReadCollection.mockResolvedValue({
        videos: [
          { id: 'c1', title: 'One', url: 'https://www.youtube.com/watch?v=c1' },
          { id: 'c2', title: 'Two', url: 'https://www.youtube.com/watch?v=c2' },
        ],
        downloadStatuses: { c1: true, c2: true },
        lastUpdatedDates: { c1: '2026-09-20T00:00:00.000Z', c2: '2020-01-01T00:00:00.000Z' },
      });

      const response = await request(app).get('/api/folder/summaries');

      expect(response.body.summaries[OTHER_FOLDER]).toEqual({
        videos: 2,
        downloaded: 2,
        notDownloaded: 0,
        stale: 1,
        newestUpdate: '2026-09-20T00:00:00.000Z',
      });
      expect(response.body.summaries[FOLDER].videos).toBe(3);
      expect(mockedReadCollection).toHaveBeenCalledTimes(1);
      expect(mockedReadCollection).toHaveBeenCalledWith(OTHER_FOLDER);
    });

    it('refuses a folder outside the configured list', async () => {
      const response = await request(app).get('/api/folder/summaries').query({ folderPath: '/etc' });

      expect(response.status).toBe(403);
      expect(mockedFs.readFile).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/folder/rebuild-index', () => {
    it('rebuilds and reports the entry count', async () => {
      mockedRebuildIndex.mockResolvedValue({
        version: 1,
        builtAt: '2024-01-01T00:00:00.000Z',
        entries: { a: { baseName: 'a', videoFile: 'a.mp4', infoMtime: 'x' } },
      });

      const response = await request(app).post('/api/folder/rebuild-index').send({ folderPath: FOLDER });

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

      const response = await request(app).post('/api/folder/download-playlist').send({ folderPath: FOLDER });

      expect(response.status).toBe(404);
    });

    it('returns 400 when channelUrl is not configured', async () => {
      mockedReadFolderConfig.mockResolvedValue({});

      const response = await request(app).post('/api/folder/download-playlist').send({ folderPath: FOLDER });

      expect(response.status).toBe(400);
    });

    it('returns 400 when the configured channelUrl is not a YouTube channel URL', async () => {
      mockedReadFolderConfig.mockResolvedValue({ channelUrl: 'http://169.254.169.254/latest/meta-data' });

      const response = await request(app).post('/api/folder/download-playlist').send({ folderPath: FOLDER });

      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/YouTube channel URL/);
      expect(mockedSpawn).not.toHaveBeenCalled();
    });

    it('runs yt-dlp without a shell, appends /videos and stores NDJSON as an array', async () => {
      mockedReadFolderConfig.mockResolvedValue({ channelUrl: 'https://www.youtube.com/@a' });
      fakeYtDlp('{"id":"v1","title":"One"}\n{"id":"v2","title":"Two"}\n');

      const response = await request(app).post('/api/folder/download-playlist').send({ folderPath: FOLDER });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        success: true,
        videoCount: 2,
        listPath: `${FOLDER}/list.json`,
      });
      expect(mockedSpawn).toHaveBeenCalledWith(
        'yt-dlp',
        ['--flat-playlist', '-i', '-j', 'https://www.youtube.com/@a/videos'],
        { cwd: FOLDER },
      );
      expect(mockedFs.open).toHaveBeenCalledWith(expect.stringMatching(/list\.json\..*\.tmp$/), 'w');
      expect(mockFileHandle.writeFile).toHaveBeenCalledWith(
        JSON.stringify(
          [
            { id: 'v1', title: 'One' },
            { id: 'v2', title: 'Two' },
          ],
          null,
          2,
        ),
        'utf-8',
      );
      expect(mockedFs.rename).toHaveBeenCalledWith(expect.any(String), `${FOLDER}/list.json`);
    });

    it('returns 500 when yt-dlp fails', async () => {
      mockedReadFolderConfig.mockResolvedValue({ channelUrl: 'https://www.youtube.com/@a/videos' });
      fakeYtDlp('', 1);

      const response = await request(app).post('/api/folder/download-playlist').send({ folderPath: FOLDER });

      expect(response.status).toBe(500);
      expect(response.body.error).toBe('Failed to download playlist');
      expect(response.body.message).toBeUndefined();
      expect(mockedFs.open).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/folder/video-downloaded', () => {
    it('answers from the folder index', async () => {
      mockedFindEntry.mockResolvedValueOnce({ baseName: 'x', videoFile: 'x.mp4', infoMtime: 'm' });
      expect(
        VideoDownloadedResponseSchema.parse(
          (await request(app).get('/api/folder/video-downloaded').query({ folderPath: FOLDER, videoId: 'v1' })).body,
        ),
      ).toEqual({ downloaded: true });

      mockedFindEntry.mockResolvedValueOnce(null);
      expect(
        (await request(app).get('/api/folder/video-downloaded').query({ folderPath: FOLDER, videoId: 'v2' })).body,
      ).toEqual({ downloaded: false });
    });

    it('requires videoId', async () => {
      const response = await request(app).get('/api/folder/video-downloaded').query({ folderPath: FOLDER });
      expect(response.status).toBe(400);
    });
  });

  describe('queue endpoints', () => {
    it('validates enqueue input', async () => {
      expect(
        (await request(app).post('/api/folder/queue').send({ folderPath: '/x', type: 'download', videos: [] })).status,
      ).toBe(403);
      expect(
        (
          await request(app)
            .post('/api/folder/queue')
            .send({ folderPath: FOLDER, type: 'nope', videos: [{}] })
        ).status,
      ).toBe(400);
      expect(
        (await request(app).post('/api/folder/queue').send({ folderPath: FOLDER, type: 'download', videos: [] }))
          .status,
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
      expect(response.body.skipped).toEqual([{ videoId: '', reason: 'videoId or videoUrl is required' }]);
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
      expect(all.body.jobs.map((j: { videoId: string }) => j.videoId)).toEqual(['aaaaaaaaaaa', 'bbbbbbbbbbb']);

      const filtered = await request(app).get('/api/folder/queue').query({ folderPath: OTHER_FOLDER });
      expect(filtered.body.jobs.map((j: { videoId: string }) => j.videoId)).toEqual(['bbbbbbbbbbb']);
    });

    it('cancels a single job and all jobs of a folder', async () => {
      const enqueued = await request(app)
        .post('/api/folder/queue')
        .send({
          folderPath: FOLDER,
          type: 'download',
          videos: [{ videoId: 'aaaaaaaaaaa' }, { videoId: 'bbbbbbbbbbb' }, { videoId: 'ccccccccccc' }],
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
    const collectStream = (res: request.Response, callback: (err: Error | null, body: string) => void) => {
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

    // Heartbeat comments (`: ping`) never start with "data: " and are skipped;
    // every parsed event must satisfy the shared contract.
    const parseEvents = (body: string) =>
      body
        .split('\n\n')
        .filter((chunk) => chunk.startsWith('data: '))
        .map((chunk) => downloadVideoEventSchema.parse(JSON.parse(chunk.slice('data: '.length))));

    it('validates input before opening the stream', async () => {
      expect((await request(app).post('/api/folder/download-video').send({ folderPath: FOLDER })).status).toBe(400);
      expect(
        (await request(app).post('/api/folder/download-video').send({ folderPath: '/x', videoUrl: 'u' })).status,
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

    it('streams downloadStart/downloadProgress/downloadComplete events for a queued job', async () => {
      const pending = startRequest(
        request(app)
          .post('/api/folder/download-video')
          .send({ folderPath: FOLDER, videoUrl: 'https://www.youtube.com/watch?v=aaaaaaaaaaa' })
          .buffer(true)
          .parse(collectStream),
      );
      await waitForSpawn();

      expect(spawnCalls).toHaveLength(1);
      const { args, process } = at(spawnCalls, 0);
      expect(args).toContain('https://www.youtube.com/watch?v=aaaaaaaaaaa');
      process.stdout.emit('data', Buffer.from('[download] 50.0% of 1MiB\n'));
      process.stdout.emit('data', Buffer.from('[download] Destination: a.mp4\n'));
      process.stdout.emit('data', Buffer.from('[download] 100% of 1MiB\n'));
      process.emit('close', 0);

      const response = await pending;

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/text\/event-stream/);
      const events = parseEvents(response.body as string);
      expect(events[0]).toEqual({ type: 'downloadStart' });
      // The percentage lines never reach the log: a dedicated tick carries
      // the parsed progress, the Destination line still streams verbatim.
      expect(events.filter((e) => e.type === 'downloadProgress').map((e) => e.message)).toEqual([
        'Progress: 50%',
        '[download] Destination: a.mp4\n',
        'Progress: 100%',
      ]);
      expect(events.filter((e) => e.type === 'downloadProgress').map((e) => e.progress)).toEqual([50, 50, 100]);
      expect(events[events.length - 1]).toEqual({
        type: 'downloadComplete',
        message: 'Download completed successfully',
      });
      expect(activeSseStreamCount()).toBe(0);
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
          .parse(collectStream),
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
          .parse(collectStream),
      );
      await waitForSpawn();

      expect(spawnCalls).toHaveLength(1);
      at(spawnCalls, 0).process.emit('close', 1);

      const response = await pending;
      const events = parseEvents(response.body as string);

      expect(events[events.length - 1]).toEqual({
        type: 'downloadError',
        error: 'yt-dlp exited with code 1 after 1 attempts',
      });
    });

    it('writes an SSE heartbeat comment every 15 s while the job is quiet', async () => {
      jest.useFakeTimers();
      try {
        let streamData = '';
        let notifyData: (() => void) | undefined;
        const firstData = new Promise<void>((resolve) => {
          notifyData = resolve;
        });

        const pending = startRequest(
          request(app)
            .post('/api/folder/download-video')
            .send({ folderPath: FOLDER, videoUrl: 'https://youtu.be/ccccccccccc' })
            .buffer(true)
            .parse((res: request.Response, callback: (err: Error | null, body: string) => void) => {
              const stream = res as unknown as IncomingMessage;
              stream.on('data', (chunk: Buffer) => {
                streamData += chunk.toString();
                notifyData?.();
              });
              stream.on('end', () => callback(null, streamData));
            }),
        );

        // The start event opens the stream; the spawn happens synchronously
        // inside the route handler, so it is already recorded.
        await firstData;
        expect(spawnCalls).toHaveLength(1);
        expect(streamData).toContain('data: {"type":"downloadStart"}');

        // Quiet merge phases: no job events, only heartbeat comments. The
        // write is delivered to the supertest stream asynchronously, so wait
        // for the next data event after each timer advance.
        const nextData = () =>
          new Promise<void>((resolve) => {
            notifyData = resolve;
          });
        jest.advanceTimersByTime(15_000);
        await nextData();
        expect(streamData).toContain(': ping\n\n');
        jest.advanceTimersByTime(15_000);
        await nextData();
        expect(streamData.match(/: ping/g)).toHaveLength(2);

        // Finishing the job ends the stream and stops the heartbeat
        at(spawnCalls, 0).process.emit('close', 0);
        const response = await pending;
        expect(response.status).toBe(200);
        const events = parseEvents(streamData);
        expect(events[events.length - 1]).toEqual({
          type: 'downloadComplete',
          message: 'Download completed successfully',
        });
      } finally {
        jest.useRealTimers();
      }
    });
  });
});

describe('createApp (full app with body limit)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {
      /* silence expected error logs */
    });
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
