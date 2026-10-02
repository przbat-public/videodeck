import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DownloadQueue } from './services/downloadQueue/queue';
import { installShutdownHandlers, shutdown } from './shutdown';

/**
 * One loop turn: shutdown resumes on a promise chain once the queue drains, so
 * the test lets that chain finish instead of guessing a delay.
 */
const flushAsync = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('shutdown', () => {
  it('cancels the jobs, closes the server and exits 0', () => {
    const cancelJobs = vi.fn();
    const exit = vi.fn();
    const close = vi.fn((callback?: () => void) => callback?.());

    shutdown({ server: { close }, cancelJobs, exit, forceExitMs: 1000 });

    expect(cancelJobs).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('forces an exit when the server does not close in time', () => {
    vi.useFakeTimers();
    const exit = vi.fn();

    shutdown({
      server: { close: vi.fn() },
      cancelJobs: vi.fn(),
      exit,
      forceExitMs: 5000,
    });

    expect(exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5000);
    expect(exit).toHaveBeenCalledWith(1);

    vi.useRealTimers();
  });

  it('exits 1 when closing the server throws', () => {
    const exit = vi.fn();
    const close = vi.fn(() => {
      throw new Error('close failed');
    });

    shutdown({ server: { close }, cancelJobs: vi.fn(), exit });

    expect(exit).toHaveBeenCalledWith(1);
  });

  it('ends open SSE streams before closing the server', () => {
    const closeSseStreams = vi.fn();
    const exit = vi.fn();
    const close = vi.fn((callback?: () => void) => callback?.());

    shutdown({ server: { close }, cancelJobs: vi.fn(), exit, closeSseStreams });

    expect(closeSseStreams).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('stops the library watcher before closing the server', () => {
    const stopLibraryWatch = vi.fn();
    const exit = vi.fn();
    const close = vi.fn((callback?: () => void) => callback?.());

    shutdown({ server: { close }, cancelJobs: vi.fn(), exit, stopLibraryWatch });

    expect(stopLibraryWatch).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('waits for the download queue to drain before closing the server', async () => {
    const cancelJobs = vi.fn();
    const exit = vi.fn();
    const close = vi.fn((callback?: () => void) => callback?.());
    let releaseIdle: (() => void) | undefined;
    const awaitIdle = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseIdle = resolve;
        }),
    );

    shutdown({ server: { close }, cancelJobs, exit, awaitIdle, forceExitMs: 1000 });

    expect(cancelJobs).toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();

    releaseIdle?.();
    await flushAsync();

    expect(close).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('waits for a cancellation that flushes state before closing the server', async () => {
    // Stopping the queue is what puts its state file on disk, and a process
    // that exits first loses the jobs it was supposed to keep. The close waits
    // for that promise, so an exit callback can never race the write.
    let releaseCancel: (() => void) | undefined;
    const cancelJobs = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseCancel = resolve;
        }),
    );
    const exit = vi.fn();
    const close = vi.fn((callback?: () => void) => callback?.());

    shutdown({ server: { close }, cancelJobs, exit, forceExitMs: 1000 });

    expect(cancelJobs).toHaveBeenCalled();
    await flushAsync();
    expect(close).not.toHaveBeenCalled();

    releaseCancel?.();
    await flushAsync();

    expect(close).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('closes the server even when the cancellation fails', async () => {
    const exit = vi.fn();
    const close = vi.fn((callback?: () => void) => callback?.());

    shutdown({
      server: { close },
      cancelJobs: () => Promise.reject(new Error('flush failed')),
      exit,
      forceExitMs: 1000,
    });
    await flushAsync();
    await flushAsync();

    expect(close).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);
  });
});

describe('shutdown with a real queue', () => {
  it('has the queue state on disk when the process would exit', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'videodeck-shutdown-'));
    const stateFile = path.join(dir, 'queue-state.json');
    const queue = new DownloadQueue({
      stateFile,
      // The queue is paused, so nothing may spawn; the state file is the point
      spawnFn: () => {
        throw new Error('the queue is paused, nothing may spawn');
      },
    });
    try {
      queue.setPaused(true);
      queue.enqueue([
        {
          folderPath: dir,
          videoId: 'vid-flush',
          videoUrl: 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
          type: 'download',
        },
      ]);

      let contentAtExit: string | null = null;
      const exit = vi.fn((code: number) => {
        if (code === 0) {
          contentAtExit = readFileSync(stateFile, 'utf-8');
        }
      });

      await new Promise<void>((resolve) => {
        shutdown({
          server: { close: (callback?: () => void) => callback?.() },
          cancelJobs: () => queue.stopForShutdown(),
          exit: (code) => {
            exit(code);
            resolve();
          },
          forceExitMs: 1000,
        });
      });

      expect(exit).toHaveBeenCalledWith(0);
      expect(contentAtExit).not.toBeNull();
      expect(JSON.parse(String(contentAtExit))).toMatchObject({ paused: true });
      expect(String(contentAtExit)).toContain('vid-flush');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('installShutdownHandlers', () => {
  it('registers and unregisters the signal handlers', () => {
    const options = {
      server: { close: vi.fn((callback?: () => void) => callback?.()) },
      cancelJobs: vi.fn(),
      exit: vi.fn(),
    };
    const remove = installShutdownHandlers(options, ['SIGTERM']);

    expect(process.listenerCount('SIGTERM')).toBeGreaterThan(0);
    remove();
    expect(process.listenerCount('SIGTERM')).toBe(0);
  });
});
