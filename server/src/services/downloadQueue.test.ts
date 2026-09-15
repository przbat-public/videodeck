import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { QueueJob } from '@shared/api';
import { at } from '../test-utils';
import { removePartialDownloads, writeTextAtomic } from '../utils/fsUtils';
import type { EnqueueRequest, SpawnedProcess } from './downloadQueue';
import {
  clearIndexRetries,
  DownloadQueue,
  indexChangedVideos,
  readConcurrency,
  restoreQueueState,
} from './downloadQueue';
import { refreshIndex } from './folderIndex';
import { indexVideosFromDisk } from './videoScanner';
import { buildFormatSelector, buildYtDlpArgs, escapeOutputTemplate, PROGRESS_TEMPLATE } from './ytdlp';

jest.mock('./folderIndex', () => ({
  ...jest.requireActual('./folderIndex'),
  refreshIndex: jest.fn(),
}));
jest.mock('./videoScanner', () => ({
  indexVideosFromDisk: jest.fn(),
}));
jest.mock('../utils/fsUtils', () => ({
  ...jest.requireActual('../utils/fsUtils'),
  removePartialDownloads: jest.fn(),
  writeTextAtomic: jest.fn(),
}));

const realWriteTextAtomic = jest.requireActual<typeof import('../utils/fsUtils')>('../utils/fsUtils').writeTextAtomic;

const mockedRefreshIndex = refreshIndex as jest.MockedFunction<typeof refreshIndex>;
const mockedIndexVideosFromDisk = indexVideosFromDisk as jest.MockedFunction<typeof indexVideosFromDisk>;
const mockedRemovePartialDownloads = removePartialDownloads as jest.MockedFunction<typeof removePartialDownloads>;
const mockedWriteTextAtomic = writeTextAtomic as jest.MockedFunction<typeof writeTextAtomic>;

class FakeProcess extends EventEmitter implements SpawnedProcess {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = jest.fn((signal?: NodeJS.Signals) => {
    // simulate the OS closing the process shortly after SIGTERM
    setImmediate(() => this.emit('close', signal === 'SIGTERM' ? null : 0));
    return true;
  });

  output(text: string): void {
    this.stdout.emit('data', Buffer.from(text));
  }

  exit(code: number): void {
    this.emit('close', code);
  }
}

interface SpawnCall {
  command: string;
  args: string[];
  cwd: string;
  process: FakeProcess;
}

function createFakeSpawn() {
  const calls: SpawnCall[] = [];
  const spawnFn = jest.fn((command: string, args: string[], options: { cwd: string }) => {
    const process = new FakeProcess();
    calls.push({ command, args, cwd: options.cwd, process });
    return process;
  });
  return { calls, spawnFn };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

const request = (videoId: string, overrides: Partial<EnqueueRequest> = {}): EnqueueRequest => ({
  folderPath: '/videos/channel-a',
  videoId,
  videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
  title: `Video ${videoId}`,
  type: 'download',
  ...overrides,
});

describe('indexChangedVideos', () => {
  const jobWithoutStart: QueueJob = {
    id: 'job-1',
    folderPath: '/videos/channel-a',
    videoId: 'abc',
    videoUrl: 'https://yt/abc',
    type: 'download',
    status: 'running',
    createdAt: '2025-01-01T10:00:00.000Z',
    log: [],
    logLineCount: 0,
  };
  const job: QueueJob = { ...jobWithoutStart, startedAt: '2025-01-01T10:05:00.000Z' };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {
      /* silence the job-progress info logs */
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('refreshes the folder index from the job start and indexes the changed videos in Elasticsearch', async () => {
    mockedRefreshIndex.mockResolvedValue({
      index: {
        version: 1,
        builtAt: 'x',
        entries: {
          abc: { baseName: '20250101_New', videoFile: '20250101_New.mp4', infoMtime: 'x' },
          old: { baseName: '20240101_Old', videoFile: '20240101_Old.mp4', infoMtime: 'x' },
        },
      },
      changed: ['abc', 'ghost'],
      removed: [],
    });
    mockedIndexVideosFromDisk.mockResolvedValue(1);

    await indexChangedVideos(job);

    expect(mockedRefreshIndex).toHaveBeenCalledWith(
      '/videos/channel-a',
      new Date('2025-01-01T10:05:00.000Z').getTime(),
    );
    expect(mockedIndexVideosFromDisk).toHaveBeenCalledWith('/videos/channel-a', ['20250101_New']);
  });

  it('retries changed-video indexing in the background when Elasticsearch is down', async () => {
    jest.useFakeTimers();
    try {
      mockedRefreshIndex.mockResolvedValue({
        index: {
          version: 1,
          builtAt: 'x',
          entries: { abc: { baseName: '20250101_New', videoFile: '20250101_New.mp4', infoMtime: 'x' } },
        },
        changed: ['abc'],
        removed: [],
      });
      mockedIndexVideosFromDisk.mockRejectedValue(new Error('ES down'));

      await expect(indexChangedVideos(job)).resolves.toBeUndefined();

      mockedIndexVideosFromDisk.mockResolvedValue(1);
      await jest.advanceTimersByTimeAsync(30_000);
      await Promise.resolve();

      expect(mockedIndexVideosFromDisk).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
      clearIndexRetries();
    }
  });

  it('falls back to createdAt and skips Elasticsearch when nothing changed', async () => {
    mockedRefreshIndex.mockResolvedValue({
      index: { version: 1, builtAt: 'x', entries: {} },
      changed: [],
      removed: [],
    });

    await indexChangedVideos(jobWithoutStart);

    expect(mockedRefreshIndex).toHaveBeenCalledWith(
      '/videos/channel-a',
      new Date('2025-01-01T10:00:00.000Z').getTime(),
    );
    expect(mockedIndexVideosFromDisk).not.toHaveBeenCalled();
  });
});

describe('buildYtDlpArgs', () => {
  it('builds a full download with the archive file and restricted names', () => {
    const args = buildYtDlpArgs({ type: 'download', videoUrl: 'https://yt/x' });

    expect(args).toContain('--download-archive');
    expect(args[args.indexOf('--download-archive') + 1]).toBe('archive.txt');
    expect(args).toContain('--restrict-filenames');
    expect(args[args.indexOf('-o') + 1]).toBe('%(upload_date)s_%(title)s.%(ext)s');
    expect(args).toContain('--no-playlist');
    expect(args).toContain('--write-info-json');
    expect(args).toContain('--write-comments');
    expect(args).not.toContain('--skip-download');
    expect(args.at(-1)).toBe('https://yt/x');
  });

  it('builds a metadata-only update pinned to the existing file stem', () => {
    const args = buildYtDlpArgs({
      type: 'update',
      videoUrl: 'https://yt/x',
      baseName: '20240101_Old_Title',
    });

    expect(args).toContain('--skip-download');
    expect(args).toContain('--no-playlist');
    expect(args[args.indexOf('-o') + 1]).toBe('20240101_Old_Title.%(ext)s');
    expect(args).not.toContain('--download-archive');
    expect(args).not.toContain('--restrict-filenames');
    expect(args).toContain('--write-info-json');
    expect(args).toContain('--write-thumbnail');
    expect(args).toContain('--write-subs');
  });

  it('escapes percent signs in a literal stem', () => {
    expect(escapeOutputTemplate('100%_done')).toBe('100%%_done');
    const args = buildYtDlpArgs({ type: 'update', videoUrl: 'u', baseName: '50%_off' });
    expect(args[args.indexOf('-o') + 1]).toBe('50%%_off.%(ext)s');
  });

  it('rejects an update job without a baseName', () => {
    expect(() => buildYtDlpArgs({ type: 'update', videoUrl: 'u' })).toThrow(/baseName/);
  });

  it('uses default options (2160p, en subtitles, comments) when none are given', () => {
    const args = buildYtDlpArgs({ type: 'download', videoUrl: 'u' });

    expect(args[args.indexOf('-f') + 1]).toBe(buildFormatSelector(2160));
    expect(args[args.indexOf('--sub-lang') + 1]).toBe('en');
    expect(args).toContain('--write-comments');
  });

  it('applies per-folder options: height cap, subtitle languages, no comments', () => {
    const options = { maxHeight: 1080, subLangs: ['pl', 'en'], writeComments: false };
    const args = buildYtDlpArgs({ type: 'download', videoUrl: 'u', options });

    const format = args[args.indexOf('-f') + 1];
    expect(format).toBe(
      'bestvideo[height<=1080][vcodec^=avc1][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best[height<=1080]',
    );
    expect(format).not.toContain('2160');
    expect(format).toContain('[vcodec^=avc1]');
    expect(args[args.indexOf('--sub-lang') + 1]).toBe('pl,en');
    expect(args).toContain('--write-subs');
    expect(args).not.toContain('--write-comments');
  });

  it('prefers h264/avc1 mp4 before falling back to other codecs', () => {
    const selector = buildFormatSelector(2160);

    const [preferred, mp4, anyVideo] = selector.split('/');
    expect(preferred).toBe('bestvideo[height<=2160][vcodec^=avc1][ext=mp4]+bestaudio[ext=m4a]');
    expect(mp4).toBe('bestvideo[height<=2160][ext=mp4]+bestaudio[ext=m4a]');
    expect(anyVideo).toBe('bestvideo[height<=2160]+bestaudio');
  });

  it('skips all subtitle flags when subLangs is empty', () => {
    const options = { maxHeight: 2160, subLangs: [], writeComments: true };
    const args = buildYtDlpArgs({ type: 'download', videoUrl: 'u', options });

    expect(args).not.toContain('--sub-lang');
    expect(args).not.toContain('--write-subs');
    expect(args).not.toContain('--write-auto-subs');
    expect(args).toContain('--write-info-json');
    expect(args).toContain('--write-thumbnail');
  });

  it('applies subtitle and comment options to update jobs too', () => {
    const options = { maxHeight: 720, subLangs: ['pl'], writeComments: false };
    const args = buildYtDlpArgs({ type: 'update', videoUrl: 'u', baseName: 'x', options });

    expect(args[args.indexOf('--sub-lang') + 1]).toBe('pl');
    expect(args).not.toContain('--write-comments');
    expect(args).not.toContain('-f'); // no video → no format selector
  });

  it('appends per-folder extraArgs right before the URL', () => {
    const options = {
      maxHeight: 2160,
      subLangs: ['en'],
      writeComments: true,
      extraArgs: ['--no-warnings'],
    };

    const download = buildYtDlpArgs({ type: 'download', videoUrl: 'https://yt/x', options });
    expect(download.slice(-2)).toEqual(['--no-warnings', 'https://yt/x']);

    const update = buildYtDlpArgs({
      type: 'update',
      videoUrl: 'https://yt/x',
      baseName: 'stem',
      options,
    });
    expect(update.slice(-2)).toEqual(['--no-warnings', 'https://yt/x']);
  });

  it('adds file-access retries and the progress template to both job types', () => {
    const download = buildYtDlpArgs({ type: 'download', videoUrl: 'u' });
    const update = buildYtDlpArgs({ type: 'update', videoUrl: 'u', baseName: 'x' });

    for (const args of [download, update]) {
      expect(args[args.indexOf('--file-access-retries') + 1]).toBe('10');
      expect(args[args.indexOf('--retry-sleep') + 1]).toBe('file_access:exp=1:10');
      expect(args[args.indexOf('--progress-delta') + 1]).toBe('1');
      expect(args[args.indexOf('--progress-template') + 1]).toBe(PROGRESS_TEMPLATE);
    }
  });

  it('adds impersonation, fragment concurrency and SponsorBlock when configured', () => {
    const options = {
      maxHeight: 2160,
      subLangs: ['en'],
      writeComments: true,
      impersonate: true,
      concurrentFragments: 4,
      sponsorblockRemove: true,
    };
    const args = buildYtDlpArgs({ type: 'download', videoUrl: 'u', options });

    expect(args[args.indexOf('--impersonate') + 1]).toBe('chrome');
    expect(args[args.indexOf('-N') + 1]).toBe('4');
    expect(args[args.indexOf('--sponsorblock-remove') + 1]).toBe('sponsor,selfpromo,interaction');

    // defaults keep the old behaviour
    const defaults = buildYtDlpArgs({ type: 'download', videoUrl: 'u' });
    expect(defaults).not.toContain('--impersonate');
    expect(defaults).not.toContain('-N');
    expect(defaults).not.toContain('--sponsorblock-remove');
  });
});

describe('DownloadQueue', () => {
  let spawn: ReturnType<typeof createFakeSpawn>;
  let afterJob: jest.Mock<Promise<void>, [QueueJob]>;
  let queue: DownloadQueue;
  let consoleErrorSpy: jest.SpyInstance;

  /** n-th spawned yt-dlp process (fails the test when there is none) */
  const spawned = (index = 0): SpawnCall => at(spawn.calls, index);

  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {
      /* silence expected error logs */
    });
    spawn = createFakeSpawn();
    afterJob = jest.fn().mockResolvedValue(undefined);
    queue = new DownloadQueue({
      maxConcurrent: 2,
      maxConcurrentUpdates: 3,
      logTail: 5,
      maxAttempts: 1,
      spawnFn: spawn.spawnFn,
      afterJob,
    });
  });

  const update = (videoId: string, overrides: Partial<EnqueueRequest> = {}): EnqueueRequest =>
    request(videoId, { type: 'update', baseName: `20240101_${videoId}`, ...overrides });

  const statuses = () => queue.list().map((job) => [job.videoId, job.status]);

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('starts a job immediately with yt-dlp in the folder as cwd', () => {
    const job = at(queue.enqueue([request('a')]), 0);

    expect(job.status).toBe('running');
    expect(spawn.calls).toHaveLength(1);
    expect(spawned().command).toBe('yt-dlp');
    expect(spawned().cwd).toBe('/videos/channel-a');
    expect(spawned().args).toContain('https://www.youtube.com/watch?v=a');
  });

  it('leaves optional fields absent on the job when the request has none', () => {
    const job = at(
      queue.enqueue([
        {
          folderPath: '/videos/channel-a',
          videoId: 'a',
          videoUrl: 'https://yt/a',
          type: 'download',
        },
      ]),
      0,
    );

    expect('title' in job).toBe(false);
    expect('baseName' in job).toBe(false);
    expect('options' in job).toBe(false);
  });

  it('passes per-folder options through to the spawned command', () => {
    queue.enqueue([request('a', { options: { maxHeight: 1080, subLangs: ['pl'], writeComments: false } })]);

    const args = spawned().args;
    expect(args[args.indexOf('-f') + 1]).toContain('height<=1080');
    expect(args[args.indexOf('--sub-lang') + 1]).toBe('pl');
    expect(args).not.toContain('--write-comments');
  });

  it('passes baseName through to update jobs', () => {
    queue.enqueue([request('a', { type: 'update', baseName: '20240101_A' })]);

    expect(spawned().args).toContain('--skip-download');
    expect(spawned().args).toContain('20240101_A.%(ext)s');
  });

  it('runs at most one download per folder and respects the download limit', () => {
    queue.enqueue([
      request('a'),
      request('b'),
      request('c', { folderPath: '/videos/channel-b' }),
      request('d', { folderPath: '/videos/channel-c' }),
    ]);

    expect(statuses()).toEqual([
      ['a', 'running'],
      ['b', 'queued'], // same folder as a
      ['c', 'running'],
      ['d', 'queued'], // download limit of 2 reached
    ]);
  });

  describe('updates run in parallel', () => {
    it('runs several updates of one folder at once, up to the update limit', () => {
      queue.enqueue([update('a'), update('b'), update('c'), update('d')]);

      expect(statuses()).toEqual([
        ['a', 'running'],
        ['b', 'running'],
        ['c', 'running'],
        ['d', 'queued'], // update limit of 3 reached
      ]);
      expect(spawn.calls.map((call) => call.cwd)).toEqual(Array(3).fill('/videos/channel-a'));
      for (const call of spawn.calls) {
        expect(call.args).toContain('--skip-download');
      }
    });

    it('counts updates and downloads against separate limits', () => {
      queue.enqueue([
        request('d1', { folderPath: '/videos/channel-b' }),
        request('d2', { folderPath: '/videos/channel-c' }),
        request('d3', { folderPath: '/videos/channel-d' }),
        update('u1'),
        update('u2'),
        update('u3'),
        update('u4'),
      ]);

      expect(statuses()).toEqual([
        ['d1', 'running'],
        ['d2', 'running'],
        ['d3', 'queued'], // download limit, untouched by the updates
        ['u1', 'running'],
        ['u2', 'running'],
        ['u3', 'running'],
        ['u4', 'queued'], // update limit, untouched by the downloads
      ]);
    });

    it('lets a download and updates share a folder, but never two downloads', () => {
      queue.enqueue([update('u1'), update('u2'), request('d1'), request('d2')]);

      expect(statuses()).toEqual([
        ['u1', 'running'],
        ['u2', 'running'],
        ['d1', 'running'], // updates do not hold the folder for downloads
        ['d2', 'queued'], // d1 does: archive.txt
      ]);
    });

    it('does not let a queued download in a busy folder hold up updates behind it', () => {
      queue.enqueue([request('d1'), request('d2'), update('u1')]);

      expect(statuses()).toEqual([
        ['d1', 'running'],
        ['d2', 'queued'],
        ['u1', 'running'],
      ]);
    });

    it('starts the next update as soon as one finishes', async () => {
      queue.enqueue([update('a'), update('b'), update('c'), update('d')]);
      expect(spawn.calls).toHaveLength(3);

      spawned(1).process.exit(0);
      await flush();
      await flush();

      expect(statuses()).toEqual([
        ['a', 'running'],
        ['b', 'done'],
        ['c', 'running'],
        ['d', 'running'],
      ]);
      expect(spawned(3).args).toContain('https://www.youtube.com/watch?v=d');
    });

    it('runs two updates at once by default', () => {
      queue = new DownloadQueue({ spawnFn: spawn.spawnFn, afterJob });
      queue.enqueue([update('a'), update('b'), update('c')]);

      expect(statuses()).toEqual([
        ['a', 'running'],
        ['b', 'running'],
        ['c', 'queued'],
      ]);
    });

    it('treats the update limit as at least one', () => {
      queue = new DownloadQueue({ maxConcurrentUpdates: 0, spawnFn: spawn.spawnFn, afterJob });
      queue.enqueue([update('a'), update('b')]);

      expect(statuses()).toEqual([
        ['a', 'running'],
        ['b', 'queued'],
      ]);
    });
  });

  describe('post-job hooks per folder', () => {
    /** afterJob that only completes when the test says so */
    const gate = () => {
      const release = new Map<string, () => void>();
      afterJob.mockImplementation(
        (job) =>
          new Promise<void>((resolve) => {
            release.set(job.videoId, resolve);
          }),
      );
      return async (videoId: string) => {
        release.get(videoId)?.();
        await flush();
        await flush();
      };
    };

    it('runs one hook at a time per folder, in the order the jobs finished', async () => {
      const release = gate();
      queue.enqueue([update('a'), update('b'), update('c')]);

      spawned(1).process.exit(0);
      spawned(0).process.exit(0);
      spawned(2).process.exit(0);
      await flush();

      // all three processes are gone, but only the first finisher's hook runs
      expect(afterJob).toHaveBeenCalledTimes(1);
      expect(afterJob).toHaveBeenCalledWith(expect.objectContaining({ videoId: 'b' }));
      expect(statuses().map(([, status]) => status)).toEqual(['running', 'running', 'running']);

      await release('b');
      expect(afterJob).toHaveBeenCalledTimes(2);
      expect(afterJob).toHaveBeenLastCalledWith(expect.objectContaining({ videoId: 'a' }));
      expect(statuses()).toEqual([
        ['a', 'running'],
        ['b', 'done'],
        ['c', 'running'],
      ]);

      await release('a');
      expect(afterJob).toHaveBeenCalledTimes(3);
      expect(afterJob).toHaveBeenLastCalledWith(expect.objectContaining({ videoId: 'c' }));

      await release('c');
      expect(statuses().map(([, status]) => status)).toEqual(['done', 'done', 'done']);
    });

    it('does not make one folder wait for the hooks of another', async () => {
      const release = gate();
      queue.enqueue([update('a'), update('b', { folderPath: '/videos/channel-b' })]);

      spawned(0).process.exit(0);
      spawned(1).process.exit(0);
      await flush();

      expect(afterJob).toHaveBeenCalledTimes(2);

      await release('b');
      expect(statuses()).toEqual([
        ['a', 'running'], // its own hook is still pending
        ['b', 'done'],
      ]);
    });

    it('lets the next hook in the folder run after one fails', async () => {
      afterJob.mockRejectedValueOnce(new Error('index broken')).mockResolvedValueOnce(undefined);
      queue.enqueue([update('a'), update('b')]);

      spawned(0).process.exit(0);
      spawned(1).process.exit(0);
      await flush();
      await flush();
      await flush();

      expect(afterJob).toHaveBeenCalledTimes(2);
      expect(statuses().map(([, status]) => status)).toEqual(['done', 'done']);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('downloadQueue: afterJob failed for a:'),
        expect.any(Error),
      );
    });

    it('survives a hook that throws instead of rejecting', async () => {
      afterJob.mockImplementationOnce(() => {
        throw new Error('sync boom');
      });
      const job = at(queue.enqueue([update('a')]), 0);

      spawned().process.exit(0);
      await flush();
      await flush();

      expect(queue.get(job.id)?.status).toBe('done');
      expect(consoleErrorSpy).toHaveBeenCalled();
    });

    it('frees the folder slot once its last hook is done, so a later job starts a fresh chain', async () => {
      queue.enqueue([update('a')]);
      spawned().process.exit(0);
      await flush();
      await flush();
      expect(statuses()).toEqual([['a', 'done']]);

      const release = gate();
      queue.enqueue([update('b')]);
      spawned(1).process.exit(0);
      await flush();

      expect(afterJob).toHaveBeenCalledTimes(2);
      await release('b');
      expect(statuses()).toEqual([
        ['a', 'done'],
        ['b', 'done'],
      ]);
    });
  });

  it('starts the next job when one finishes', async () => {
    queue.enqueue([request('a'), request('b')]);
    expect(spawn.calls).toHaveLength(1);

    spawned().process.exit(0);
    await flush();
    await flush();

    expect(queue.get(at(queue.list(), 0).id)?.status).toBe('done');
    expect(spawn.calls).toHaveLength(2);
    expect(spawned(1).args).toContain('https://www.youtube.com/watch?v=b');
  });

  it('calls afterJob before marking a successful job done', async () => {
    let resolveAfter: () => void = () => {
      /* replaced by the pending hook's promise executor below */
    };
    afterJob.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveAfter = resolve;
        }),
    );
    const job = at(queue.enqueue([request('a')]), 0);

    spawned().process.exit(0);
    await flush();

    expect(afterJob).toHaveBeenCalledWith(expect.objectContaining({ videoId: 'a' }));
    expect(queue.get(job.id)?.status).toBe('running');

    resolveAfter();
    await flush();
    await flush();

    expect(queue.get(job.id)).toMatchObject({ status: 'done', progress: 100, exitCode: 0 });
  });

  it('still marks the job done when afterJob fails', async () => {
    afterJob.mockRejectedValue(new Error('index broken'));
    const job = at(queue.enqueue([request('a')]), 0);

    spawned().process.exit(0);
    await flush();
    await flush();

    expect(queue.get(job.id)?.status).toBe('done');
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it('marks a job as error on a non-zero exit code', async () => {
    const job = at(queue.enqueue([request('a')]), 0);

    spawned().process.output('ERROR: video unavailable\n');
    spawned().process.exit(1);
    await flush();

    expect(queue.get(job.id)).toMatchObject({
      status: 'error',
      exitCode: 1,
      error: 'yt-dlp exited with code 1 after 1 attempts',
      log: ['ERROR: video unavailable'],
    });
    expect(afterJob).not.toHaveBeenCalled();
  });

  it('treats a members-only failure that exits 0 as an error, not a success', async () => {
    const job = at(queue.enqueue([request('a')]), 0);

    spawned().process.output(
      "ERROR: [youtube] a: This video is available to this channel's members. Join this channel to get access to members-only content.\n",
    );
    spawned().process.exit(0);
    await flush();
    await flush();

    expect(queue.get(job.id)).toMatchObject({
      status: 'error',
      exitCode: 0,
      error: 'members-only',
    });
    expect(afterJob).not.toHaveBeenCalled();
  });

  describe('retries', () => {
    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    const waitFor = async (condition: () => boolean): Promise<void> => {
      for (let i = 0; i < 100; i += 1) {
        if (condition()) {
          return;
        }
        await sleep(5);
      }
      throw new Error('condition not met in time');
    };

    let retryQueue: DownloadQueue;
    beforeEach(() => {
      retryQueue = new DownloadQueue({
        maxConcurrent: 1,
        maxAttempts: 3,
        retryDelayMs: 5,
        spawnFn: spawn.spawnFn,
        afterJob,
      });
    });

    it('retries a failed run and succeeds on the second attempt', async () => {
      const job = at(retryQueue.enqueue([request('a')]), 0);

      spawned(0).process.exit(1);
      await flush();
      expect(retryQueue.get(job.id)?.status).toBe('running'); // waiting out the backoff

      await sleep(15);
      await flush();
      expect(spawn.calls).toHaveLength(2);

      spawned(1).process.exit(0);
      await flush();
      await flush();
      expect(retryQueue.get(job.id)?.status).toBe('done');
    });

    it('gives up after maxAttempts failures', async () => {
      const job = at(retryQueue.enqueue([request('a')]), 0);

      spawned(0).process.exit(1);
      await flush();
      await waitFor(() => spawn.calls.length === 2);
      spawned(1).process.exit(1);
      await flush();
      await waitFor(() => spawn.calls.length === 3);
      spawned(2).process.exit(1);
      await flush();

      expect(spawn.calls).toHaveLength(3);
      const finalJob = retryQueue.get(job.id);
      expect(finalJob?.status).toBe('error');
      expect(finalJob?.error).toContain('after 3 attempts');
    });

    it('cancelling during the backoff stops the retry', async () => {
      const job = at(retryQueue.enqueue([request('a')]), 0);

      spawned(0).process.exit(1);
      await flush();
      retryQueue.cancel(job.id);

      await sleep(15);
      await flush();

      expect(spawn.calls).toHaveLength(1);
      expect(retryQueue.get(job.id)?.status).toBe('cancelled');
    });

    it('fails a members-only video at once instead of waiting out the backoff', async () => {
      const job = at(retryQueue.enqueue([request('a')]), 0);

      spawned(0).process.output(
        "ERROR: [youtube] obNLctxL3_c: This video is available to this channel's members on level: Supporter (or any higher level). Join this channel to get access to members-only content and other exclusive perks.\n",
      );
      spawned(0).process.exit(1);
      await flush();
      await sleep(15);
      await flush();

      expect(spawn.calls).toHaveLength(1); // no second attempt
      expect(retryQueue.get(job.id)).toMatchObject({
        status: 'error',
        exitCode: 1,
        error: 'members-only',
      });
    });
  });

  it('marks a job as error when the process cannot be spawned', async () => {
    const job = at(queue.enqueue([request('a')]), 0);

    spawned().process.emit('error', new Error('spawn yt-dlp ENOENT'));
    spawned().process.exit(-2);
    await flush();

    expect(queue.get(job.id)).toMatchObject({ status: 'error', error: 'spawn yt-dlp ENOENT' });
  });

  it('keeps only the log tail and parses progress', () => {
    const job = at(queue.enqueue([request('a')]), 0);
    const process = spawned().process;

    process.output('[youtube] a: Downloading webpage\n');
    process.output('[download]   1.0% of 10MiB\r[download]  45.5% of 10MiB\n');
    process.output('line3\nline4\nline5\nline6\n');

    const snapshot = queue.get(job.id);
    expect(snapshot?.log).toHaveLength(5);
    expect(snapshot?.log.at(-1)).toBe('line6');
    expect(snapshot?.progress).toBe(45.5);
  });

  it('does not duplicate an active job for the same folder/video, even across types', () => {
    const first = at(queue.enqueue([request('a')]), 0);
    const second = at(queue.enqueue([request('a')]), 0);
    // An update racing a download would overwrite the file the download is
    // writing — the dedup spans job types on purpose.
    const update = at(queue.enqueue([request('a', { type: 'update', baseName: 'x' })]), 0);

    expect(second.id).toBe(first.id);
    expect(update.id).toBe(first.id);
    expect(queue.list()).toHaveLength(1);
  });

  it('cancels a queued job without spawning it', () => {
    const queued = at(queue.enqueue([request('a'), request('b')]), 1);

    expect(queue.cancel(queued.id)).toBe(true);
    expect(queue.get(queued.id)?.status).toBe('cancelled');
    expect(spawn.calls).toHaveLength(1);
    expect(mockedRemovePartialDownloads).not.toHaveBeenCalled();
  });

  it('kills a running job on cancel, sweeps partial files and moves on to the next one', async () => {
    const running = at(queue.enqueue([request('a'), request('b')]), 0);

    expect(queue.cancel(running.id)).toBe(true);
    expect(spawned().process.kill).toHaveBeenCalledWith('SIGTERM');
    await flush();
    await flush();

    expect(queue.get(running.id)?.status).toBe('cancelled');
    expect(spawn.calls).toHaveLength(2);
    expect(afterJob).not.toHaveBeenCalled();
    expect(mockedRemovePartialDownloads).toHaveBeenCalledWith('/videos/channel-a');
  });

  it('kills a hung job after the idle timeout and retries it as a transient failure', async () => {
    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    const waitFor = async (condition: () => boolean): Promise<void> => {
      for (let i = 0; i < 100; i += 1) {
        if (condition()) {
          return;
        }
        await sleep(5);
      }
      throw new Error('condition not met in time');
    };

    const watchdogQueue = new DownloadQueue({
      maxConcurrent: 1,
      maxAttempts: 2,
      retryDelayMs: 5,
      idleTimeoutMs: 30,
      spawnFn: spawn.spawnFn,
      afterJob,
    });
    const job = at(watchdogQueue.enqueue([request('a')]), 0);

    // No output ever arrives: the watchdog SIGTERMs the process group and
    // the queue retries the job like any transient failure.
    await waitFor(() => spawned().process.kill.mock.calls.some(([signal]) => signal === 'SIGTERM'));
    await waitFor(() => spawn.calls.length === 2);
    await flush();

    expect(watchdogQueue.get(job.id)?.status).toBe('running');
    expect(spawn.calls.length).toBe(2);
    // The hung attempt must not have run the success hook
    expect(afterJob).not.toHaveBeenCalled();
  });

  it('returns false when cancelling an unknown or finished job', async () => {
    const job = at(queue.enqueue([request('a')]), 0);
    spawned().process.exit(1);
    await flush();
    expect(queue.cancel(job.id)).toBe(false);
    expect(queue.cancel('nope')).toBe(false);
  });

  it('holds queued jobs while paused and starts them on resume', async () => {
    // downloads are exclusive per folder, so spread them across folders
    queue.enqueue([request('a'), request('b', { folderPath: '/videos/channel-b' })]);
    queue.setPaused(true);
    queue.enqueue([request('c', { folderPath: '/videos/channel-c' })]);
    await flush();

    expect(spawn.calls).toHaveLength(2); // a and b were already running
    expect(spawn.calls[2]).toBeUndefined();

    queue.setPaused(false);
    spawned(0).process.exit(0); // free a slot — c may start once unpaused
    await flush();

    expect(spawn.calls).toHaveLength(3);
  });

  it('does not start queued jobs while paused, even when a slot frees up', async () => {
    queue.enqueue([
      request('a'),
      request('b', { folderPath: '/videos/channel-b' }),
      request('c', { folderPath: '/videos/channel-c' }),
    ]);
    queue.setPaused(true);

    spawned(0).process.exit(0);
    await flush();

    expect(spawn.calls).toHaveLength(2); // c still waiting for the resume
  });

  it('clearFinished drops finished and cancelled jobs and keeps active ones', () => {
    const enqueued = queue.enqueue([request('a'), request('b')]);
    const running = at(enqueued, 0);
    const queued = at(enqueued, 1);

    expect(queue.cancel(queued.id)).toBe(true);
    expect(queue.clearFinished()).toBe(1);

    const jobs = queue.list();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.id).toBe(running.id);
    expect(queue.clearFinished()).toBe(0);
  });

  it('cancelAll cancels active jobs, optionally only for one folder', () => {
    queue.enqueue([request('a'), request('b'), request('c', { folderPath: '/videos/channel-b' })]);

    expect(queue.cancelAll('/videos/channel-a')).toBe(2);
    expect(queue.list().map((job) => job.status)).toEqual(['cancelled', 'cancelled', 'running']);
  });

  it('filters list by folder and returns copies', () => {
    queue.enqueue([request('a'), request('c', { folderPath: '/videos/channel-b' })]);

    const listed = queue.list('/videos/channel-b');
    expect(listed.map((job) => job.videoId)).toEqual(['c']);

    at(listed, 0).log.push('mutated');
    expect(queue.get(at(listed, 0).id)?.log).toEqual([]);
  });

  it('emits job events on every status/log change', async () => {
    const events: Array<[string, string]> = [];
    queue.on('job', (job: QueueJob) => events.push([job.videoId, job.status]));

    queue.enqueue([request('a')]);
    spawned().process.output('hello\n');
    spawned().process.exit(0);
    await flush();
    await flush();

    expect(events).toEqual([
      ['a', 'queued'],
      ['a', 'running'],
      ['a', 'running'], // log line
      ['a', 'done'],
    ]);
  });

  it('prunes finished jobs older than the retention window', async () => {
    const shortQueue = new DownloadQueue({
      spawnFn: spawn.spawnFn,
      afterJob,
      retainFinishedMs: 1000,
      maxAttempts: 1,
    });
    const job = at(shortQueue.enqueue([request('a')]), 0);
    spawned().process.exit(1);
    await flush();

    shortQueue.prune(Date.now() + 500);
    expect(shortQueue.get(job.id)).toBeDefined();

    shortQueue.prune(Date.now() + 5000);
    expect(shortQueue.get(job.id)).toBeUndefined();
  });
});

describe('queue state persistence', () => {
  let stateFile: string;

  beforeEach(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'queue-state-'));
    stateFile = path.join(dir, 'state.json');
    jest.clearAllMocks();
    mockedWriteTextAtomic.mockImplementation(realWriteTextAtomic);
  });

  afterEach(async () => {
    await fs.rm(path.dirname(stateFile), { recursive: true, force: true });
  });

  const silentAfterJob = (): jest.Mock<Promise<void>, [QueueJob]> => jest.fn().mockResolvedValue(undefined);

  /** Persisted writes are fire-and-forget — poll until the state satisfies the predicate. */
  const waitForState = async (predicate: (state: { paused?: boolean; jobs?: QueueJob[] }) => boolean) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        if (predicate(JSON.parse(await fs.readFile(stateFile, 'utf-8')))) {
          return;
        }
      } catch {
        // not written yet
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('state file never reached the expected shape');
  };

  it('persists active jobs on enqueue and clears them once they finish', async () => {
    const spawn = createFakeSpawn();
    const queue = new DownloadQueue({
      spawnFn: spawn.spawnFn,
      afterJob: silentAfterJob(),
      stateFile,
      maxAttempts: 1,
    });
    queue.enqueue([request('a')]);

    await waitForState((state) => (state.jobs ?? []).some((job) => job.videoId === 'a'));
    const persisted = JSON.parse(await fs.readFile(stateFile, 'utf-8')) as { paused?: boolean; jobs?: QueueJob[] };
    const persistedJob = at(persisted.jobs ?? [], 0);
    expect(persistedJob.folderPath).toBe('/videos/channel-a');
    expect(persistedJob.log).toEqual([]);

    at(spawn.calls, 0).process.exit(0);
    await waitForState((state) => (state.jobs ?? []).length === 0);
  });

  it('persists the paused flag', async () => {
    const queue = new DownloadQueue({
      spawnFn: createFakeSpawn().spawnFn,
      afterJob: silentAfterJob(),
      stateFile,
    });
    queue.setPaused(true);
    await waitForState((state) => state.paused === true);
  });

  it('serializes state writes so an older snapshot cannot land after a newer one', async () => {
    // Every persistState call returns a promise we resolve by hand, so the
    // test controls exactly when each write completes.
    const writes: Array<{ text: string; release: () => void }> = [];
    mockedWriteTextAtomic.mockImplementation(
      (_file, text) =>
        new Promise<void>((resolve) => {
          writes.push({ text, release: resolve });
        }),
    );

    const queue = new DownloadQueue({
      spawnFn: createFakeSpawn().spawnFn,
      afterJob: silentAfterJob(),
      stateFile,
      maxAttempts: 1,
    });
    queue.setPaused(true);
    queue.enqueue([request('a')]);
    await flush();

    // The pause snapshot is still in flight, so the enqueue snapshot must
    // wait. Writing both at once would let the older, job-less snapshot
    // rename over the newer one and resurrect stale state after a reboot.
    expect(mockedWriteTextAtomic).toHaveBeenCalledTimes(1);
    expect((JSON.parse(writes[0]?.text ?? '{}') as { jobs?: QueueJob[] }).jobs).toHaveLength(0);

    // Only once the pause write is done may the enqueue snapshot go out.
    writes[0]?.release();
    await flush();
    expect(mockedWriteTextAtomic).toHaveBeenCalledTimes(2);
    const enqueueState = JSON.parse(writes[1]?.text ?? '{}') as { paused?: boolean; jobs?: QueueJob[] };
    expect(enqueueState.paused).toBe(true);
    expect(enqueueState.jobs).toHaveLength(1);
    expect(enqueueState.jobs?.[0]?.videoId).toBe('a');
    writes[1]?.release();
    await flush();
  });

  it('restores jobs as queued, honors the paused flag and skips corrupt entries', async () => {
    await fs.writeFile(
      stateFile,
      JSON.stringify({
        paused: true,
        jobs: [
          {
            folderPath: '/videos/channel-a',
            videoId: 'a',
            videoUrl: 'https://www.youtube.com/watch?v=a',
            title: 'A',
            type: 'download',
          },
          { folderPath: '/videos/channel-a', videoId: 'b', type: 'update', baseName: '20240101_b' },
          null,
          7,
          { folderPath: 42, videoId: 'c' },
          { folderPath: '/videos/channel-a' },
        ],
      }),
    );

    const spawn = createFakeSpawn();
    const queue = new DownloadQueue({
      spawnFn: spawn.spawnFn,
      afterJob: silentAfterJob(),
      stateFile,
      maxAttempts: 1,
    });
    await expect(restoreQueueState(queue, stateFile)).resolves.toBe(2);

    const jobs = queue.list('/videos/channel-a');
    expect(jobs.map((job) => [job.videoId, job.type, job.status])).toEqual([
      ['a', 'download', 'queued'],
      ['b', 'update', 'queued'],
    ]);
    expect(spawn.spawnFn).not.toHaveBeenCalled();
  });

  it('returns 0 when the state file is missing or unparseable', async () => {
    await expect(restoreQueueState(new DownloadQueue({ stateFile }), stateFile)).resolves.toBe(0);

    await fs.writeFile(stateFile, '{not json');
    await expect(restoreQueueState(new DownloadQueue({ stateFile }), stateFile)).resolves.toBe(0);
  });

  it('waitForIdle resolves once the last child process is gone', async () => {
    const spawn = createFakeSpawn();
    const queue = new DownloadQueue({
      spawnFn: spawn.spawnFn,
      afterJob: silentAfterJob(),
      maxAttempts: 1,
    });
    queue.enqueue([request('a')]);

    let resolved = false;
    const waiting = queue.waitForIdle(5000).then(() => {
      resolved = true;
    });
    await flush();
    expect(resolved).toBe(false);

    at(spawn.calls, 0).process.exit(0);
    await waiting;
    expect(resolved).toBe(true);
  });

  it('waitForIdle gives up after the timeout with a live child', async () => {
    const queue = new DownloadQueue({
      spawnFn: createFakeSpawn().spawnFn,
      afterJob: silentAfterJob(),
      maxAttempts: 1,
    });
    queue.enqueue([request('a')]);

    await expect(queue.waitForIdle(50)).resolves.toBeUndefined();
    expect(at(queue.list(), 0).status).toBe('running');
  });
});

describe('readConcurrency', () => {
  it.each([
    ['an unset variable', undefined, 2],
    ['an empty string', '', 2],
    ['a positive integer', '10', 10],
    ['a number with trailing garbage', '4x', 4],
    ['zero', '0', 2],
    ['a negative number', '-3', 2],
    ['a fraction below one', '0.5', 2],
    ['text', 'many', 2],
  ])('reads %s (%p) as %i', (_label, value, expected) => {
    expect(readConcurrency(value, 2)).toBe(expected);
  });
});
