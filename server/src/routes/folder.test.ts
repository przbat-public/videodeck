import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { UPDATE_STALE_AFTER_MS } from '@videodeck/shared/dates';
import {
  ArchiveReconcileResponseSchema,
  ClearFinishedResponseSchema,
  downloadVideoEventSchema,
  EnqueueJobsResponseSchema,
  FOLDER_UNAVAILABLE_CODE,
  FolderListResponseSchema,
  FolderStateResponseSchema,
  FolderSummariesResponseSchema,
  QueueListResponseSchema,
  QueuePauseResponseSchema,
  StatusResponseSchema,
  VideoDownloadedResponseSchema,
  VideoStateResponseSchema,
} from '@videodeck/shared/schemas';
import { extractYoutubeVideoId } from '@videodeck/shared/youtube';
import type express from 'express';
import request from 'supertest';
import type { Mock, Mocked, MockedFunction } from 'vitest';
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
import {
  ARCHIVE_FILE,
  findEntryByVideoId,
  getDownloadStatuses,
  loadIndex,
  readArchiveIds,
  rebuildIndex,
} from '../services/folderIndex';
import { reconcileLibrary, resetLibraryState } from '../services/libraryState';
import { at, indexEntry, indexFile } from '../test-utils';
import { activeSseStreamCount } from '../utils/sseRegistry';
import { invalidateStatusCache, invalidateSummaryCache } from './folder';

vi.mock('node:fs/promises');
vi.mock('node:child_process');
vi.mock('../config', async () => {
  const actual = await vi.importActual<typeof import('../config')>('../config');
  return { ...actual, getVideosFolderPaths: vi.fn() };
});
vi.mock('../services/folderIndex');
vi.mock('../services/collection');
vi.mock('../services/elasticsearchService', () => ({
  listCachedFolders: vi.fn(),
}));
vi.mock('../services/folderConfig', async () => {
  const actual = await vi.importActual<typeof import('../services/folderConfig')>('../services/folderConfig');
  return {
    ...actual,
    readFolderConfig: vi.fn(),
    loadDownloadOptions: vi.fn(),
    invalidateCategoryCache: vi.fn(),
  };
});

/** yt-dlp process handed to the queue by the fake spawn below (a `SpawnedProcess`) */
interface FakeSpawnedProcess extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: Mock<(signal?: NodeJS.Signals) => boolean>;
}

interface SpawnCall {
  args: string[];
  cwd: string;
  process: FakeSpawnedProcess;
}

/**
 * Every spawn the fake below records, in order. A `vi.mock` factory runs in a
 * scope hoisted above this file's imports, so it cannot read a variable
 * declared here: `vi.hoisted` lifts the declaration to the same place and the
 * factory fills this very array.
 */
const spawnCalls = vi.hoisted((): SpawnCall[] => []);

// Real queue with a fake spawn so that route <-> queue integration is exercised.
vi.mock('../services/downloadQueue', async () => {
  const actual = await vi.importActual<typeof import('../services/downloadQueue')>('../services/downloadQueue');
  const { EventEmitter: EE } = await vi.importActual<typeof import('events')>('events');
  const spawnFn = (_cmd: string, args: string[], options: { cwd: string }): SpawnedProcess => {
    const proc: FakeSpawnedProcess = Object.assign(new EE(), {
      stdout: new EE(),
      stderr: new EE(),
      kill: vi.fn(() => {
        setImmediate(() => proc.emit('close', null));
        return true;
      }),
    });
    spawnCalls.push({ args, cwd: options.cwd, process: proc });
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
  };
});

const mockedFs = fs as Mocked<typeof fs>;
const mockedSpawn = spawn as MockedFunction<typeof spawn>;
const mockedGetVideosFolderPaths = getVideosFolderPaths as MockedFunction<typeof getVideosFolderPaths>;
const mockedFindEntry = findEntryByVideoId as MockedFunction<typeof findEntryByVideoId>;
const mockedLoadIndex = loadIndex as MockedFunction<typeof loadIndex>;
const mockedReadArchiveIds = readArchiveIds as MockedFunction<typeof readArchiveIds>;
const mockedGetDownloadStatuses = getDownloadStatuses as MockedFunction<typeof getDownloadStatuses>;
const mockedRebuildIndex = rebuildIndex as MockedFunction<typeof rebuildIndex>;
const mockedReadFolderConfig = readFolderConfig as MockedFunction<typeof readFolderConfig>;
const mockedLoadDownloadOptions = loadDownloadOptions as MockedFunction<typeof loadDownloadOptions>;
const mockedListCachedFolders = listCachedFolders as MockedFunction<typeof listCachedFolders>;
const mockedReadCollection = readCollection as MockedFunction<typeof readCollection>;

const FOLDER = '/videos/channel-a';
const OTHER_FOLDER = '/videos/channel-b';

/** Path of a folder's list.json, as the handlers ask the fs mock for it */
const listFile = (folder: string): string => path.join(folder, 'list.json');

/**
 * The env value this file inherits. The library snapshot reads the process env
 * and vitest reuses a worker process across files, so the folder tests restore
 * it when the file is done instead of leaving the next file an empty library.
 */
const inheritedVideosFolderPath = process.env.VIDEOS_FOLDER_PATH;

const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/** File handle handed out by the fs.open mock (writeJsonAtomic) */
const mockFileHandle = {
  writeFile: vi.fn<(path: string, encoding: BufferEncoding) => Promise<void>>(),
  sync: vi.fn<() => Promise<void>>(),
  close: vi.fn<() => Promise<void>>(),
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
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {
      /* silence expected error logs */
    });
    // The library snapshot is module-level and reads the process env on every
    // read: pin it to an empty library, so only the tests that move it see a
    // folder and nothing leaks into the next test of this file.
    process.env.VIDEOS_FOLDER_PATH = '';
    resetLibraryState();
    mockedGetVideosFolderPaths.mockReturnValue([FOLDER, OTHER_FOLDER]);
    mockedFs.mkdir.mockResolvedValue(undefined);
    // The mounted-folder guard asks the disk before anything is created; the
    // unmounted case has its own tests.
    mockedFs.stat.mockResolvedValue({ isDirectory: () => true } as unknown as Awaited<ReturnType<typeof fs.stat>>);
    mockedFs.writeFile.mockResolvedValue(undefined);
    mockedFs.open.mockResolvedValue(mockFileHandle as unknown as import('node:fs/promises').FileHandle);
    mockedFs.rename.mockResolvedValue(undefined);
    mockFileHandle.writeFile.mockResolvedValue(undefined);
    mockFileHandle.sync.mockResolvedValue(undefined);
    mockFileHandle.close.mockResolvedValue(undefined);
    mockedReadFolderConfig.mockResolvedValue(null);
    // A download consults the folder index to decide whether the video is
    // still missing, so every test starts from "nothing downloaded" and the
    // tests that need an entry set it themselves.
    mockedLoadIndex.mockResolvedValue(indexFile([]));
    mockedLoadDownloadOptions.mockResolvedValue({ ...DEFAULT_DOWNLOAD_OPTIONS });
    mockedListCachedFolders.mockResolvedValue({ folders: new Set([FOLDER]), elasticsearchUp: true });
    downloadQueue.clear();
    spawnCalls.length = 0;
    // Both caches in routes/folder are module-level and outlive a test: the
    // summary cache and the 5 s /api/status body. Reset both here so a test
    // that asks for either under its own mocks cannot serve the next test the
    // previous answer (a stale status body once said "elasticsearch: down").
    invalidateSummaryCache();
    invalidateStatusCache();
    app = createApp();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(() => {
    if (inheritedVideosFolderPath === undefined) {
      delete process.env.VIDEOS_FOLDER_PATH;
    } else {
      process.env.VIDEOS_FOLDER_PATH = inheritedVideosFolderPath;
    }
    resetLibraryState();
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
        unavailableFolders: [],
        elasticsearch: 'ok',
        status: 'ok',
      });
      expect(mockedListCachedFolders).toHaveBeenCalledWith([FOLDER, OTHER_FOLDER]);
    });

    it('serves the folders from disk when Elasticsearch is unreachable', async () => {
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

    it('reports an unplugged folder as unavailable', async () => {
      const root = fsSync.mkdtempSync(path.join(os.tmpdir(), 'videodeck-library-'));
      const folderPath = path.join(root, 'kanal');
      fsSync.mkdirSync(folderPath, { recursive: true });
      process.env.VIDEOS_FOLDER_PATH = folderPath;
      resetLibraryState();

      const online = StatusResponseSchema.parse((await request(app).get('/api/status')).body);
      expect(online.unavailableFolders).toEqual([]);

      // The drive leaves. The scan behind reconcileLibrary asks the mocked fs
      // whether the folder is a directory, so the mock has to fail for it: the
      // file's default answers "yes" for the mounted-folder guard, and a path
      // that is gone is exactly what an unplugged volume looks like. The
      // literal root stays configured either way.
      fsSync.rmSync(folderPath, { recursive: true, force: true });
      mockedFs.stat.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      await reconcileLibrary();

      const offline = StatusResponseSchema.parse((await request(app).get('/api/status')).body);
      expect(offline.unavailableFolders).toEqual([folderPath]);
    });

    it('serves a fresh body when the library revision moves without the folder list changing', async () => {
      // The route reads its folders from the mocked config, so both reads below
      // report the same list. Only the library moves.
      process.env.VIDEOS_FOLDER_PATH = '/videos/dysk-a';
      resetLibraryState();
      const first = StatusResponseSchema.parse((await request(app).get('/api/status')).body);
      expect(first.unavailableFolders).toEqual(['/videos/dysk-a']);

      process.env.VIDEOS_FOLDER_PATH = '/videos/dysk-b';
      const second = StatusResponseSchema.parse((await request(app).get('/api/status')).body);

      // Well inside the 5 s cache window: the folder list alone would have
      // served the first body again. The path that left is no longer covered
      // by the configured roots, so the memory drops it, and the new path is
      // reported as gone: the two bodies differ either way.
      expect(second.videosFolderPath).toEqual(first.videosFolderPath);
      expect(first.unavailableFolders).toEqual(['/videos/dysk-a']);
      expect(second.unavailableFolders).toEqual(['/videos/dysk-b']);
    });

    it('shares one disk pass between two concurrent status reads', async () => {
      // A slow disk is the case this guards: both readers arrive before the
      // first body exists, which is what two tabs opening together look like.
      mockedReadFolderConfig.mockImplementation(async () => {
        await new Promise((resolve) => setImmediate(resolve));
        return null;
      });

      const [first, second] = await Promise.all([request(app).get('/api/status'), request(app).get('/api/status')]);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(first.body).toEqual(second.body);
      // One pass over the two configured folders, not two
      expect(mockedReadFolderConfig).toHaveBeenCalledTimes(2);
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

    it('refuses to save a config for a folder whose drive is away', async () => {
      // Saving mkdir'd the folder first, so a config for a drive that is not
      // mounted landed on the internal disk, and every later read (status,
      // search, downloads) looked at that empty directory instead of the drive.
      mockedFs.stat.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

      const response = await request(app)
        .put('/api/folder/config')
        .send({ folderPath: FOLDER, config: { channelUrl: 'https://www.youtube.com/@a' } });

      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({ code: FOLDER_UNAVAILABLE_CODE });
      expect(mockedFs.mkdir).not.toHaveBeenCalled();
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
      vi.spyOn(os, 'homedir').mockReturnValue('/videos');

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
      const realFs = (await vi.importActual<typeof import('fs/promises')>(
        'fs/promises',
      )) as typeof import('fs/promises');
      const fixture = await realFs.readFile(`${__dirname}/../test/fixtures/ytdlp-list.json`, 'utf-8');
      mockedFs.readFile.mockResolvedValue(fixture);
      mockedGetDownloadStatuses.mockResolvedValue({
        downloadStatuses: {},
        lastUpdatedDates: {},
      });

      const response = await request(app).get('/api/folder/list').query({ folderPath: FOLDER });

      expect(response.status).toBe(200);
      // The catalog carries the metadata a flat-playlist dump has and the app
      // reads: the two counts come straight from the fixture, and the list
      // stays in the order the channel returned.
      expect(response.body.videos).toMatchObject([
        {
          id: 'yf__frUKreI',
          title: 'Walksnail Ascent Firmware Update How-To',
          url: 'https://www.youtube.com/watch?v=yf__frUKreI',
          duration: 615,
          viewCount: 12044,
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

    /**
     * The staleness rule is "older than UPDATE_STALE_AFTER_MS" (shared/dates.ts),
     * so a hardcoded "recent" date turns stale 30 days after it is written and
     * reddens this suite with no code change. These two dates are derived from
     * the rule instead: one lands in the middle of the window, the other far
     * outside it.
     */
    const FRESH_UPDATE = new Date(Date.now() - UPDATE_STALE_AFTER_MS / 2).toISOString();
    const ANCIENT_UPDATE = '2020-01-01T00:00:00.000Z';

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
                  v1: FRESH_UPDATE,
                  v2: ANCIENT_UPDATE,
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
            unavailable: 0,
            stale: 1,
            newestUpdate: FRESH_UPDATE,
          },
          [OTHER_FOLDER]: { videos: 1, downloaded: 0, notDownloaded: 1, unavailable: 0, stale: 0 },
        },
      });
    });

    it('counts a members-only video as unavailable instead of a missing download', async () => {
      mockedFs.readFile.mockImplementation((filePath) => {
        const target = String(filePath);
        if (target === listPath(OTHER_FOLDER)) {
          return Promise.resolve(
            JSON.stringify([
              { id: 'w1', title: 'Members only', url: 'https://yt/watch?v=w1', availability: 'subscriber_only' },
            ]),
          );
        }
        return Promise.reject(enoent());
      });

      const response = await request(app).get('/api/folder/summaries').query({ folderPath: OTHER_FOLDER });

      expect(response.body.summaries[OTHER_FOLDER]).toEqual({
        videos: 1,
        downloaded: 0,
        notDownloaded: 1,
        unavailable: 1,
        stale: 0,
      });
    });

    it('counts a video the folder recorded a permanent failure for as unavailable', async () => {
      // A real-looking id, because the record only accepts keys shaped like
      // YouTube video ids: `w1` and friends are for the catalog fixtures.
      const recordedId = 'dQw4w9WgXcQ';
      const record = {
        version: 1,
        entries: { [recordedId]: { code: 'removed', at: new Date().toISOString() } },
      };
      mockedFs.readFile.mockImplementation((filePath) => {
        const target = String(filePath);
        if (target === listPath(OTHER_FOLDER)) {
          return Promise.resolve(listOf([recordedId]));
        }
        if (target === `${OTHER_FOLDER}/.unavailable.json`) {
          return Promise.resolve(JSON.stringify(record));
        }
        return Promise.reject(enoent());
      });

      const response = await request(app).get('/api/folder/summaries').query({ folderPath: OTHER_FOLDER });

      expect(response.body.summaries[OTHER_FOLDER].unavailable).toBe(1);
    });

    it('reports zeroes for a folder without a readable list.json', async () => {
      mockedFs.readFile.mockRejectedValue(enoent());

      const response = await request(app).get('/api/folder/summaries');

      expect(response.status).toBe(200);
      expect(response.body.summaries).toEqual({
        [FOLDER]: { videos: 0, downloaded: 0, notDownloaded: 0, unavailable: 0, stale: 0 },
        [OTHER_FOLDER]: { videos: 0, downloaded: 0, notDownloaded: 0, unavailable: 0, stale: 0 },
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
        summaries: { [OTHER_FOLDER]: { videos: 1, downloaded: 0, notDownloaded: 1, unavailable: 0, stale: 0 } },
      });
      // Two reads for the one folder: its list.json and its unavailable record,
      // not two per configured folder
      expect(mockedFs.readFile).toHaveBeenCalledTimes(2);
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
            ? { downloadStatuses: { w1: true }, lastUpdatedDates: { w1: FRESH_UPDATE } }
            : { downloadStatuses: {}, lastUpdatedDates: {} },
        ),
      );

      const one = await request(app).get('/api/folder/summaries').query({ folderPath: OTHER_FOLDER });
      const all = await request(app).get('/api/folder/summaries');

      const fresh = {
        videos: 1,
        downloaded: 1,
        notDownloaded: 0,
        unavailable: 0,
        stale: 0,
        newestUpdate: FRESH_UPDATE,
      };
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
        lastUpdatedDates: { c1: FRESH_UPDATE, c2: ANCIENT_UPDATE },
      });

      const response = await request(app).get('/api/folder/summaries');

      expect(response.body.summaries[OTHER_FOLDER]).toEqual({
        videos: 2,
        downloaded: 2,
        notDownloaded: 0,
        unavailable: 0,
        stale: 1,
        newestUpdate: FRESH_UPDATE,
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

    it('shares one disk pass between two concurrent summary reads', async () => {
      // Two disk reads per folder, so a second tab arriving while the first
      // answer is still being built is the difference between two passes and
      // one; the delay keeps that window open on purpose.
      mockedGetDownloadStatuses.mockImplementation(async () => {
        await new Promise((resolve) => setImmediate(resolve));
        return { downloadStatuses: {}, lastUpdatedDates: {} };
      });

      const [first, second] = await Promise.all([
        request(app).get('/api/folder/summaries'),
        request(app).get('/api/folder/summaries'),
      ]);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(first.body).toEqual(second.body);
      expect(mockedGetDownloadStatuses).toHaveBeenCalledTimes(2);
    });
  });

  describe('POST /api/folder/rebuild-index', () => {
    it('rebuilds and reports the entry count', async () => {
      mockedRebuildIndex.mockResolvedValue(indexFile(['a']));

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

    it('refuses a playlist download into a folder whose drive is away', async () => {
      // The listing is written into the folder, so a folder that is not there
      // right now must not be materialised on the internal disk for it.
      mockedReadFolderConfig.mockResolvedValue({ channelUrl: 'https://www.youtube.com/@a' });
      mockedFs.stat.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      // Without the guard the request keeps going and the automocked spawn never
      // answers, so the test has to fail on the 409 rather than hang waiting.
      fakeYtDlp('{"id":"v1","title":"One"}\n');

      const response = await request(app)
        .post('/api/folder/download-playlist')
        .send({ folderPath: FOLDER })
        .timeout({ response: 1000, deadline: 2000 });

      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({ code: FOLDER_UNAVAILABLE_CODE });
      expect(mockedFs.mkdir).not.toHaveBeenCalled();
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
        ['--ignore-config', '--flat-playlist', '-i', '-j', 'https://www.youtube.com/@a/videos'],
        { cwd: FOLDER },
      );
      expect(mockedFs.open).toHaveBeenCalledWith(expect.stringMatching(/list\.json\..*\.tmp$/), 'w');
      expect(mockFileHandle.writeFile).toHaveBeenCalledWith(
        JSON.stringify(
          [
            { id: 'v1', title: 'One', url: '' },
            { id: 'v2', title: 'Two', url: '' },
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

    it('makes the next status report the list.json it just wrote', async () => {
      mockedReadFolderConfig.mockResolvedValue({ channelUrl: 'https://www.youtube.com/@a' });
      // The console asked before the fetch: with no readable list.json, the
      // cached status answer says the folder has none
      mockedFs.access.mockRejectedValue(enoent());
      expect((await request(app).get('/api/status')).body.listExists[FOLDER]).toBe(false);

      fakeYtDlp('{"id":"v1","title":"One"}\n');
      await request(app).post('/api/folder/download-playlist').send({ folderPath: FOLDER });

      // The fetch wrote list.json. A status served from the 5 s cache would
      // still report the old answer and leave the console's "show videos"
      // toggle disabled after the reader fetched the playlist.
      mockedFs.access.mockResolvedValue(undefined);
      expect((await request(app).get('/api/status')).body.listExists[FOLDER]).toBe(true);
    });

    it('makes the next counts read the videos it just wrote', async () => {
      mockedReadFolderConfig.mockResolvedValue({ channelUrl: 'https://www.youtube.com/@a' });
      mockedGetDownloadStatuses.mockResolvedValue({ downloadStatuses: {}, lastUpdatedDates: {} });
      // The console counted the folder before the fetch: an unreadable
      // list.json is a channel with no videos
      mockedFs.readFile.mockRejectedValue(enoent());
      expect((await request(app).get('/api/folder/summaries')).body.summaries[FOLDER].videos).toBe(0);

      fakeYtDlp('{"id":"v1","title":"One"}\n');
      await request(app).post('/api/folder/download-playlist').send({ folderPath: FOLDER });

      // The counts follow the list the fetch wrote instead of the 5 s cache
      mockedFs.readFile.mockResolvedValue(
        JSON.stringify([{ id: 'v1', title: 'One', url: 'https://www.youtube.com/watch?v=v1' }]),
      );
      expect((await request(app).get('/api/folder/summaries')).body.summaries[FOLDER].videos).toBe(1);
    });
  });

  describe('GET /api/folder/video-downloaded', () => {
    it('answers from the folder index', async () => {
      mockedFindEntry.mockResolvedValueOnce(indexEntry({ baseName: 'x', videoFile: 'x.mp4' }));
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

    it('skips a members-only video instead of queueing a job that cannot succeed', async () => {
      const membersOnly = 'dQw4w9WgXcQ';
      mockedFs.readFile.mockImplementation((filePath) => {
        const target = String(filePath);
        if (target === `${FOLDER}/list.json`) {
          return Promise.resolve(
            JSON.stringify([
              {
                id: membersOnly,
                title: 'Members only',
                url: `https://www.youtube.com/watch?v=${membersOnly}`,
                availability: 'subscriber_only',
              },
              { id: 'aaaaaaaaaaa', title: 'Public', url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa' },
            ]),
          );
        }
        return Promise.reject(enoent());
      });

      const response = await request(app)
        .post('/api/folder/queue')
        .send({
          folderPath: FOLDER,
          type: 'download',
          videos: [{ videoId: membersOnly }, { videoId: 'aaaaaaaaaaa' }],
        });

      expect(response.status).toBe(202);
      expect(response.body.skipped).toEqual([{ videoId: membersOnly, reason: 'members-only' }]);
      expect(response.body.jobs).toHaveLength(1);
      expect(response.body.jobs[0]).toMatchObject({ videoId: 'aaaaaaaaaaa', type: 'download' });
      expect(spawnCalls).toHaveLength(1);
    });

    it('skips a Premium-only video', async () => {
      const premiumOnly = '9bZkp7q19f0';
      mockedFs.readFile.mockImplementation((filePath) => {
        const target = String(filePath);
        if (target === `${FOLDER}/list.json`) {
          return Promise.resolve(
            JSON.stringify([
              {
                id: premiumOnly,
                title: 'Premium only',
                url: `https://www.youtube.com/watch?v=${premiumOnly}`,
                availability: 'premium_only',
              },
            ]),
          );
        }
        return Promise.reject(enoent());
      });

      const response = await request(app)
        .post('/api/folder/queue')
        .send({ folderPath: FOLDER, type: 'download', videos: [{ videoId: premiumOnly }] });

      expect(response.status).toBe(202);
      expect(response.body.jobs).toHaveLength(0);
      expect(response.body.skipped).toEqual([{ videoId: premiumOnly, reason: 'premium-only' }]);
      expect(spawnCalls).toHaveLength(0);
    });

    it('still enqueues when the catalog cannot be read', async () => {
      // The availability check is an optimization for the console, never a
      // gate: a folder whose list.json is unreadable downloads as before.
      mockedFs.readFile.mockRejectedValue(Object.assign(new Error('EACCES'), { code: 'EACCES' }));

      const response = await request(app)
        .post('/api/folder/queue')
        .send({ folderPath: FOLDER, type: 'download', videos: [{ videoId: 'aaaaaaaaaaa' }] });

      expect(response.status).toBe(202);
      expect(response.body.jobs).toHaveLength(1);
      expect(response.body.skipped).toEqual([]);
    });

    it('refuses to enqueue into a folder whose drive is away', async () => {
      // A literal root stays in the allowlist while its volume is unmounted, so
      // without this check the request either answered a generic 500 (EACCES) or
      // created the folder on the internal disk and downloaded there instead.
      mockedFs.stat.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

      const response = await request(app)
        .post('/api/folder/queue')
        .send({ folderPath: FOLDER, type: 'download', videos: [{ videoId: 'aaaaaaaaaaa' }] });

      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({ code: FOLDER_UNAVAILABLE_CODE });
      expect(String(response.body.message)).toContain('not mounted');
      expect(mockedFs.mkdir).not.toHaveBeenCalled();
      expect(spawnCalls).toHaveLength(0);
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
        ...indexFile([]),
        builtAt: 'now',
        entries: { aaaaaaaaaaa: indexEntry({ baseName: '20240101_Old_Name', videoFile: 'x.mp4' }) },
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

    it('reports the paused state of the queue itself, not a copy the router keeps', async () => {
      // The queue is paused by something other than the pause route — a restart
      // restoring `paused: true` from the state file does exactly this.
      downloadQueue.setPaused(true);
      try {
        const listing = await request(app).get('/api/folder/queue');

        expect(QueueListResponseSchema.parse(listing.body).paused).toBe(true);
      } finally {
        downloadQueue.setPaused(false);
      }
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

    it('refuses a download into a folder whose drive is away', async () => {
      mockedFs.stat.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

      const response = await request(app)
        .post('/api/folder/download-video')
        .send({ folderPath: FOLDER, videoUrl: 'https://www.youtube.com/watch?v=aaaaaaaaaaa' })
        // Without the guard this request opens the progress stream and never
        // ends, so the test has to fail on the answer rather than hang.
        .timeout({ response: 1000, deadline: 2000 });

      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({ code: FOLDER_UNAVAILABLE_CODE });
      expect(mockedFs.mkdir).not.toHaveBeenCalled();
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
      vi.useFakeTimers();
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
        vi.advanceTimersByTime(15_000);
        await nextData();
        expect(streamData).toContain(': ping\n\n');
        vi.advanceTimersByTime(15_000);
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
        vi.useRealTimers();
      }
    });
  });
});

describe('createApp (full app with body limit)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {
      /* silence expected error logs */
    });
    mockedGetVideosFolderPaths.mockReturnValue([FOLDER]);
    // The mount guard asks the disk before anything is created, so this block
    // stubs its own answer rather than inheriting the one a neighbouring
    // describe happened to set: `-t` has to pass with no other test in front
    // of it, and a shuffled order must not decide the outcome either.
    mockedFs.stat.mockResolvedValue({ isDirectory: () => true } as unknown as Awaited<ReturnType<typeof fs.stat>>);
    mockedFs.mkdir.mockResolvedValue(undefined);
    mockedLoadDownloadOptions.mockResolvedValue({ ...DEFAULT_DOWNLOAD_OPTIONS });
    downloadQueue.clear();
    spawnCalls.length = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

describe('folder state endpoints', () => {
  let app: express.Application;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {
      /* silence expected error logs */
    });
    process.env.VIDEOS_FOLDER_PATH = '';
    resetLibraryState();
    mockedGetVideosFolderPaths.mockReturnValue([FOLDER]);
    mockedFs.mkdir.mockResolvedValue(undefined);
    mockedFs.stat.mockResolvedValue({ isDirectory: () => true } as unknown as Awaited<ReturnType<typeof fs.stat>>);
    // archive.txt is rewritten through the atomic writer, which opens a temp
    // file: without this the write dies on the mocked handle.
    mockedFs.writeFile.mockResolvedValue(undefined);
    mockedFs.open.mockResolvedValue(mockFileHandle as unknown as import('node:fs/promises').FileHandle);
    mockedFs.rename.mockResolvedValue(undefined);
    mockFileHandle.writeFile.mockResolvedValue(undefined);
    mockFileHandle.sync.mockResolvedValue(undefined);
    mockFileHandle.close.mockResolvedValue(undefined);
    mockedReadFolderConfig.mockResolvedValue(null);
    mockedLoadIndex.mockResolvedValue(indexFile([]));
    mockedReadArchiveIds.mockResolvedValue(new Set());
    mockedLoadDownloadOptions.mockResolvedValue({ ...DEFAULT_DOWNLOAD_OPTIONS });
    mockedListCachedFolders.mockResolvedValue({ folders: new Set([FOLDER]), elasticsearchUp: true });
    downloadQueue.clear();
    spawnCalls.length = 0;
    invalidateSummaryCache();
    invalidateStatusCache();
    app = createApp();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('folder state', () => {
    /** list.json with one video, and an index holding it plus a deleted one */
    function seedStateFolder(): void {
      mockedGetVideosFolderPaths.mockReturnValue([FOLDER]);
      mockedFs.readFile.mockImplementation((filePath) => {
        const target = String(filePath);
        if (target === listFile(FOLDER)) {
          return Promise.resolve(
            JSON.stringify([{ id: 'aaaaaaaaaaa', title: 'Kept', url: 'https://youtu.be/aaaaaaaaaaa' }]),
          );
        }
        if (target === path.join(FOLDER, ARCHIVE_FILE)) {
          return Promise.resolve('youtube aaaaaaaaaaa\nyoutube gone0000001\n');
        }
        return Promise.reject(enoent());
      });
      mockedLoadIndex.mockResolvedValue({
        ...indexFile([]),
        entries: {
          aaaaaaaaaaa: indexEntry({
            baseName: '20240101_Kept',
            subtitleLangs: ['en'],
            hasComments: true,
            hasDescription: true,
            hasThumbnail: true,
            videoBytes: 2048,
            infoBytes: 512,
          }),
          deleted0001: indexEntry({ baseName: '20230101_Deleted', title: 'Deleted from the channel' }),
        },
      });
    }

    it('reports what each video has, what it misses and which videos only exist on disk', async () => {
      seedStateFolder();
      mockedReadFolderConfig.mockResolvedValue({ subLangs: ['pl', 'en'] });

      const response = await request(app).get('/api/folder/state').query({ folderPath: FOLDER });

      expect(response.status).toBe(200);
      const body = FolderStateResponseSchema.parse(response.body);
      expect(body.videos).toHaveLength(1);
      expect(body.videos[0]).toMatchObject({
        id: 'aaaaaaaaaaa',
        downloadState: {
          files: { video: true, thumbnail: true, description: true, subLangs: ['en'], comments: true },
          // The Polish subtitle is the gap, which is what the console reports
          missing: ['pl'],
        },
      });
      expect(body.orphans.map((video) => video.id)).toEqual(['deleted0001']);
      expect(body.orphans[0]?.orphan).toBe(true);
      expect(body.counts).toEqual({ videos: 1, downloaded: 1, incomplete: 1, notDownloaded: 0, orphans: 1 });
    });

    it('reports the archive drift in both directions', async () => {
      seedStateFolder();

      const body = FolderStateResponseSchema.parse(
        (await request(app).get('/api/folder/state').query({ folderPath: FOLDER })).body,
      );

      // `deleted0001` is on disk but not in the archive; `gone0000001` is the
      // other way round, a video whose files were deleted after a download.
      expect(body.drift.missingFromArchive).toEqual(['deleted0001']);
      expect(body.drift.missingFromDisk).toEqual(['gone0000001']);
    });

    it('filters the list without changing the counts', async () => {
      seedStateFolder();
      mockedReadFolderConfig.mockResolvedValue({ subLangs: ['pl', 'en'] });

      const incomplete = FolderStateResponseSchema.parse(
        (await request(app).get('/api/folder/state').query({ folderPath: FOLDER, filter: 'incomplete' })).body,
      );
      expect(incomplete.videos.map((video) => video.id)).toEqual(['aaaaaaaaaaa']);
      expect(incomplete.orphans).toEqual([]);
      expect(incomplete.counts.orphans).toBe(1);

      const notDownloaded = FolderStateResponseSchema.parse(
        (await request(app).get('/api/folder/state').query({ folderPath: FOLDER, filter: 'not-downloaded' })).body,
      );
      expect(notDownloaded.videos).toEqual([]);

      const orphans = FolderStateResponseSchema.parse(
        (await request(app).get('/api/folder/state').query({ folderPath: FOLDER, filter: 'orphan' })).body,
      );
      expect(orphans.orphans.map((video) => video.id)).toEqual(['deleted0001']);
    });

    it('lists every orphan, sorted, whatever the filter', async () => {
      // The sort and the map only run once there is more than one orphan, and
      // an unsorted list is the kind of bug a screenshot does not catch.
      seedStateFolder();
      mockedLoadIndex.mockResolvedValue({
        ...indexFile([]),
        entries: {
          aaaaaaaaaaa: indexEntry({ baseName: '20240101_Kept' }),
          zzzzzzzzzzz: indexEntry({ baseName: '20230101_Last', title: 'Last' }),
          bbbbbbbbbbb: indexEntry({ baseName: '20220101_First', title: 'First' }),
        },
      });

      const body = FolderStateResponseSchema.parse(
        (await request(app).get('/api/folder/state').query({ folderPath: FOLDER, filter: 'orphan' })).body,
      );

      expect(body.orphans.map((video) => video.id)).toEqual(['bbbbbbbbbbb', 'zzzzzzzzzzz']);
      expect(body.orphans.map((video) => video.title)).toEqual(['First', 'Last']);
      expect(body.counts.orphans).toBe(2);
    });

    it('refuses an unknown filter and an unknown folder', async () => {
      seedStateFolder();

      expect((await request(app).get('/api/folder/state').query({ folderPath: FOLDER, filter: 'nope' })).status).toBe(
        400,
      );
      expect((await request(app).get('/api/folder/state').query({ folderPath: '/etc' })).status).toBe(403);
    });

    it('answers one video state and says when the id is unknown', async () => {
      seedStateFolder();

      const known = VideoStateResponseSchema.parse(
        (await request(app).get('/api/folder/video-state').query({ folderPath: FOLDER, videoId: 'aaaaaaaaaaa' })).body,
      );
      expect(known.known).toBe(true);
      expect(known.state.files?.video).toBe(true);

      const unknown = VideoStateResponseSchema.parse(
        (await request(app).get('/api/folder/video-state').query({ folderPath: FOLDER, videoId: 'zzzzzzzzzzz' })).body,
      );
      expect(unknown.known).toBe(false);
      expect(unknown.state.files).toBeNull();
      expect(unknown.state.missing).toEqual([]);
    });

    it('rejects a videoId that is not a YouTube id', async () => {
      seedStateFolder();

      const response = await request(app)
        .get('/api/folder/video-state')
        .query({ folderPath: FOLDER, videoId: '../../etc/passwd' });

      expect(response.status).toBe(400);
    });

    it('asks for a videoId when the query carries none', async () => {
      seedStateFolder();

      const response = await request(app).get('/api/folder/video-state').query({ folderPath: FOLDER });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('videoId is required');
    });

    it('refuses a folder whose drive is away', async () => {
      // The mounted-folder guard asks the disk before anything else, so a
      // folder that is not a directory answers with the unavailable code
      // instead of an empty state that reads like "nothing downloaded".
      mockedFs.stat.mockResolvedValue({ isDirectory: () => false } as unknown as Awaited<ReturnType<typeof fs.stat>>);

      const response = await request(app).get('/api/folder/state').query({ folderPath: FOLDER });

      expect(response.status).toBe(409);
    });
  });

  describe('archive reconcile', () => {
    it('rewrites the archive from the disk and reports the diff', async () => {
      mockedGetVideosFolderPaths.mockReturnValue([FOLDER]);
      mockedFs.stat.mockResolvedValue({ isDirectory: () => true } as unknown as Awaited<ReturnType<typeof fs.stat>>);
      // The unmounted-drive guard lists the folder first: one info.json is
      // what makes reconcile follow the disk.
      mockedFs.readdir.mockResolvedValue(['20240101_Kept.info.json', 'archive.txt'] as never);
      // The atomic writer renames a temp file over archive.txt; the read that
      // follows has to see the new content, so the fake remembers the write.
      let archiveBody = 'youtube ghost000001\n';
      mockFileHandle.writeFile.mockImplementation((content: string) => {
        archiveBody = content;
        return Promise.resolve();
      });
      mockedFs.readFile.mockImplementation((filePath) => {
        const target = String(filePath);
        if (target === path.join(FOLDER, ARCHIVE_FILE)) {
          return Promise.resolve(archiveBody);
        }
        if (target.endsWith('.info.json')) {
          return Promise.resolve('{}');
        }
        return Promise.reject(enoent());
      });
      mockedLoadIndex.mockResolvedValue(indexFile(['aaaaaaaaaaa']));

      const response = await request(app)
        .post('/api/folder/archive/reconcile')
        .send({ folderPath: FOLDER, method: 'rebuild' });

      expect(response.status).toBe(200);
      const body = ArchiveReconcileResponseSchema.parse(response.body);
      expect(body.added).toEqual(['aaaaaaaaaaa']);
      expect(body.removed).toEqual(['ghost000001']);
      expect(body.drift).toEqual({ missingFromArchive: [], missingFromDisk: [] });
    });

    it('rejects a videoIds list that is not an array of ids', async () => {
      mockedGetVideosFolderPaths.mockReturnValue([FOLDER]);
      mockedFs.stat.mockResolvedValue({ isDirectory: () => true } as unknown as Awaited<ReturnType<typeof fs.stat>>);

      const notAnArray = await request(app)
        .post('/api/folder/archive/reconcile')
        .send({ folderPath: FOLDER, method: 'remove', videoIds: 'aaaaaaaaaaa' });
      expect(notAnArray.status).toBe(400);

      const invalidId = await request(app)
        .post('/api/folder/archive/reconcile')
        .send({ folderPath: FOLDER, method: 'remove', videoIds: ['../etc'] });
      expect(invalidId.status).toBe(400);
    });

    it('refuses a method it does not know', async () => {
      mockedGetVideosFolderPaths.mockReturnValue([FOLDER]);
      mockedFs.stat.mockResolvedValue({ isDirectory: () => true } as unknown as Awaited<ReturnType<typeof fs.stat>>);

      const response = await request(app)
        .post('/api/folder/archive/reconcile')
        .send({ folderPath: FOLDER, method: 'delete-everything' });

      expect(response.status).toBe(400);
    });

    it('refuses to rebuild while the drive looks unmounted', async () => {
      // No .info.json anywhere: emptying the archive here would send the next
      // run over the whole channel.
      mockedGetVideosFolderPaths.mockReturnValue([FOLDER]);
      mockedFs.stat.mockResolvedValue({ isDirectory: () => true } as unknown as Awaited<ReturnType<typeof fs.stat>>);
      mockedFs.readdir.mockResolvedValue(['archive.txt', 'config.json'] as never);
      mockedLoadIndex.mockResolvedValue(indexFile([]));

      const response = await request(app)
        .post('/api/folder/archive/reconcile')
        .send({ folderPath: FOLDER, method: 'rebuild' });

      expect(response.status).toBe(409);
      expect(String(response.body.error)).toMatch(/unmounted/);
    });
  });

  describe('repair endpoint', () => {
    it('queues sidecar-only jobs pinned to the existing stem', async () => {
      mockedGetVideosFolderPaths.mockReturnValue([FOLDER]);
      mockedLoadIndex.mockResolvedValue({
        ...indexFile([]),
        entries: { aaaaaaaaaaa: indexEntry({ baseName: '20240101_Kept' }) },
      });

      const response = await request(app)
        .post('/api/folder/repair')
        .send({ folderPath: FOLDER, method: 'sidecars', videos: [{ videoId: 'aaaaaaaaaaa' }] });

      expect(response.status).toBe(202);
      const body = EnqueueJobsResponseSchema.parse(response.body);
      expect(body.jobs).toHaveLength(1);
      expect(body.jobs[0]).toMatchObject({ type: 'repair', baseName: '20240101_Kept' });
      expect(body.jobs[0]?.writeComments).toBeUndefined();

      await flush();
      expect(at(spawnCalls, 0).args).toContain('--skip-download');
      expect(at(spawnCalls, 0).args).toContain('--write-subs');
      expect(at(spawnCalls, 0).args).not.toContain('--write-comments');
      expect(at(spawnCalls, 0).args.some((arg) => arg.includes('archive'))).toBe(false);
    });

    it('refreshes comments only when the method asks for it', async () => {
      mockedGetVideosFolderPaths.mockReturnValue([FOLDER]);
      mockedLoadIndex.mockResolvedValue({
        ...indexFile([]),
        entries: { aaaaaaaaaaa: indexEntry({ baseName: '20240101_Kept' }) },
      });

      const response = await request(app)
        .post('/api/folder/repair')
        .send({ folderPath: FOLDER, method: 'comments', videos: [{ videoId: 'aaaaaaaaaaa' }] });

      expect(response.status).toBe(202);
      expect(EnqueueJobsResponseSchema.parse(response.body).jobs[0]?.writeComments).toBe(true);

      await flush();
      expect(at(spawnCalls, 0).args).toContain('--write-comments');
    });

    it('skips a video that is not downloaded rather than repairing nothing', async () => {
      mockedGetVideosFolderPaths.mockReturnValue([FOLDER]);
      mockedLoadIndex.mockResolvedValue(indexFile([]));

      const response = await request(app)
        .post('/api/folder/repair')
        .send({ folderPath: FOLDER, method: 'sidecars', videos: [{ videoId: 'aaaaaaaaaaa' }] });

      expect(response.status).toBe(202);
      expect(EnqueueJobsResponseSchema.parse(response.body)).toMatchObject({
        jobs: [],
        skipped: [{ videoId: 'aaaaaaaaaaa', reason: 'not downloaded' }],
      });
    });

    it('rejects an empty video list and an unknown method', async () => {
      mockedGetVideosFolderPaths.mockReturnValue([FOLDER]);

      expect(
        (await request(app).post('/api/folder/repair').send({ folderPath: FOLDER, method: 'sidecars', videos: [] }))
          .status,
      ).toBe(400);
      expect(
        (
          await request(app)
            .post('/api/folder/repair')
            .send({ folderPath: FOLDER, method: 'everything', videos: [{ videoId: 'aaaaaaaaaaa' }] })
        ).status,
      ).toBe(400);
    });
  });

  describe('download decision', () => {
    it('skips a download for a video the folder already holds', async () => {
      mockedGetVideosFolderPaths.mockReturnValue([FOLDER]);
      mockedLoadIndex.mockResolvedValue({
        ...indexFile([]),
        entries: { aaaaaaaaaaa: indexEntry({ baseName: '20240101_Kept' }) },
      });

      const response = await request(app)
        .post('/api/folder/queue')
        .send({ folderPath: FOLDER, type: 'download', videos: [{ videoId: 'aaaaaaaaaaa' }] });

      expect(response.status).toBe(202);
      expect(EnqueueJobsResponseSchema.parse(response.body)).toMatchObject({
        jobs: [],
        skipped: [{ videoId: 'aaaaaaaaaaa', reason: 'already downloaded' }],
      });
      expect(spawnCalls).toHaveLength(0);
    });

    it('downloads a video the folder does not hold, whatever archive.txt says', async () => {
      // The archive is not consulted: a video whose files were deleted stays in
      // it, so the app answers from the disk.
      mockedGetVideosFolderPaths.mockReturnValue([FOLDER]);
      mockedLoadIndex.mockResolvedValue(indexFile([]));

      const response = await request(app)
        .post('/api/folder/queue')
        .send({ folderPath: FOLDER, type: 'download', videos: [{ videoId: 'aaaaaaaaaaa' }] });

      expect(EnqueueJobsResponseSchema.parse(response.body).jobs).toHaveLength(1);
      expect(EnqueueJobsResponseSchema.parse(response.body).skipped).toEqual([]);
    });
  });
});
