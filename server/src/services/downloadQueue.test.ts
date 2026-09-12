import { EventEmitter } from 'events';
import type { QueueJob } from '@shared/api';
import {
  DownloadQueue,
  buildFormatSelector,
  buildYtDlpArgs,
  escapeOutputTemplate,
  indexChangedVideos,
} from './downloadQueue';
import type { EnqueueRequest, SpawnedProcess } from './downloadQueue';
import { refreshIndex } from './folderIndex';
import { indexVideosFromDisk } from './videoScanner';
import { at } from '../test-utils';

jest.mock('./folderIndex', () => ({
  ...jest.requireActual('./folderIndex'),
  refreshIndex: jest.fn(),
}));
jest.mock('./videoScanner', () => ({
  indexVideosFromDisk: jest.fn(),
}));

const mockedRefreshIndex = refreshIndex as jest.MockedFunction<typeof refreshIndex>;
const mockedIndexVideosFromDisk = indexVideosFromDisk as jest.MockedFunction<
  typeof indexVideosFromDisk
>;

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
    jest.spyOn(console, 'log').mockImplementation(() => {});
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
    });
    mockedIndexVideosFromDisk.mockResolvedValue(1);

    await indexChangedVideos(job);

    expect(mockedRefreshIndex).toHaveBeenCalledWith(
      '/videos/channel-a',
      new Date('2025-01-01T10:05:00.000Z').getTime()
    );
    expect(mockedIndexVideosFromDisk).toHaveBeenCalledWith('/videos/channel-a', ['20250101_New']);
  });

  it('falls back to createdAt and skips Elasticsearch when nothing changed', async () => {
    mockedRefreshIndex.mockResolvedValue({
      index: { version: 1, builtAt: 'x', entries: {} },
      changed: [],
    });

    await indexChangedVideos(jobWithoutStart);

    expect(mockedRefreshIndex).toHaveBeenCalledWith(
      '/videos/channel-a',
      new Date('2025-01-01T10:00:00.000Z').getTime()
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
      'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best[height<=1080]'
    );
    expect(format).not.toContain('2160');
    expect(args[args.indexOf('--sub-lang') + 1]).toBe('pl,en');
    expect(args).toContain('--write-subs');
    expect(args).not.toContain('--write-comments');
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
});

describe('DownloadQueue', () => {
  let spawn: ReturnType<typeof createFakeSpawn>;
  let afterJob: jest.Mock<Promise<void>, [QueueJob]>;
  let queue: DownloadQueue;

  /** n-th spawned yt-dlp process (fails the test when there is none) */
  const spawned = (index = 0): SpawnCall => at(spawn.calls, index);

  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    spawn = createFakeSpawn();
    afterJob = jest.fn().mockResolvedValue(undefined);
    queue = new DownloadQueue({ maxConcurrent: 2, logTail: 5, spawnFn: spawn.spawnFn, afterJob });
  });

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
      0
    );

    expect('title' in job).toBe(false);
    expect('baseName' in job).toBe(false);
    expect('options' in job).toBe(false);
  });

  it('passes per-folder options through to the spawned command', () => {
    queue.enqueue([
      request('a', { options: { maxHeight: 1080, subLangs: ['pl'], writeComments: false } }),
    ]);

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

  it('runs at most one job per folder and respects the global limit', () => {
    queue.enqueue([
      request('a'),
      request('b'),
      request('c', { folderPath: '/videos/channel-b' }),
      request('d', { folderPath: '/videos/channel-c' }),
    ]);

    const statuses = queue.list().map((job) => [job.videoId, job.status]);
    expect(statuses).toEqual([
      ['a', 'running'],
      ['b', 'queued'], // same folder as a
      ['c', 'running'],
      ['d', 'queued'], // global limit of 2 reached
    ]);
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
    let resolveAfter: () => void = () => {};
    afterJob.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveAfter = resolve;
        })
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
    expect(console.error).toHaveBeenCalled();
  });

  it('marks a job as error on a non-zero exit code', async () => {
    const job = at(queue.enqueue([request('a')]), 0);

    spawned().process.output('ERROR: video unavailable\n');
    spawned().process.exit(1);
    await flush();

    expect(queue.get(job.id)).toMatchObject({
      status: 'error',
      exitCode: 1,
      error: 'yt-dlp exited with code 1',
      log: ['ERROR: video unavailable'],
    });
    expect(afterJob).not.toHaveBeenCalled();
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

  it('does not duplicate an active job for the same folder/video/type', () => {
    const first = at(queue.enqueue([request('a')]), 0);
    const second = at(queue.enqueue([request('a')]), 0);
    const update = at(queue.enqueue([request('a', { type: 'update', baseName: 'x' })]), 0);

    expect(second.id).toBe(first.id);
    expect(update.id).not.toBe(first.id);
    expect(queue.list()).toHaveLength(2);
  });

  it('cancels a queued job without spawning it', () => {
    const queued = at(queue.enqueue([request('a'), request('b')]), 1);

    expect(queue.cancel(queued.id)).toBe(true);
    expect(queue.get(queued.id)?.status).toBe('cancelled');
    expect(spawn.calls).toHaveLength(1);
  });

  it('kills a running job on cancel and moves on to the next one', async () => {
    const running = at(queue.enqueue([request('a'), request('b')]), 0);

    expect(queue.cancel(running.id)).toBe(true);
    expect(spawned().process.kill).toHaveBeenCalledWith('SIGTERM');
    await flush();
    await flush();

    expect(queue.get(running.id)?.status).toBe('cancelled');
    expect(spawn.calls).toHaveLength(2);
    expect(afterJob).not.toHaveBeenCalled();
  });

  it('returns false when cancelling an unknown or finished job', async () => {
    const job = at(queue.enqueue([request('a')]), 0);
    spawned().process.exit(1);
    await flush();

    expect(queue.cancel(job.id)).toBe(false);
    expect(queue.cancel('nope')).toBe(false);
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
