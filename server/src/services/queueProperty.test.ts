import fc from 'fast-check';
import { EventEmitter } from 'events';
import { DownloadQueue } from './downloadQueue';
import type { SpawnedProcess } from './downloadQueue';

/**
 * Property tests for the queue's concurrency semantics: whatever the
 * sequence of enqueues, cancellations and process exits, the invariants
 * that protect downloads must hold.
 */

interface ActiveProcess {
  cwd: string;
  type: 'download' | 'update';
  process: SpawnedProcess;
}

/** A spawner whose processes the test can exit by index, like the OS would */
function createFakeSpawner() {
  const active: ActiveProcess[] = [];
  const spawnFn = (_command: string, args: string[], options: { cwd: string }) => {
    const entry: ActiveProcess = {
      cwd: options.cwd,
      type: args.includes('--skip-download') ? 'update' : 'download',
      process: null as unknown as SpawnedProcess,
    };
    const proc: SpawnedProcess = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: () => {
        // the queue no longer counts a cancelled job, so drop the entry now
        // and let the OS close the process a tick later
        const index = active.indexOf(entry);
        if (index >= 0) {
          active.splice(index, 1);
        }
        setImmediate(() => (proc as unknown as EventEmitter).emit('close', null));
        return true;
      },
    });
    entry.process = proc;
    active.push(entry);
    return proc;
  };
  const exit = (index: number) => {
    const entry = active[index];
    if (!entry) {
      return false;
    }
    active.splice(index, 1);
    (entry.process as unknown as EventEmitter).emit('close', 0);
    return true;
  };
  const runningDownloads = (cwd: string) =>
    active.filter((entry) => entry.type === 'download' && entry.cwd === cwd).length;
  const runningUpdates = () => active.filter((entry) => entry.type === 'update').length;
  const totalActive = () => active.length;
  return { spawnFn, exit, runningDownloads, runningUpdates, totalActive };
}

type Op =
  | { op: 'enqueue'; videoId: string; folder: string; type: 'download' | 'update' }
  | { op: 'exit'; slot: number }
  | { op: 'cancel-all' };

const flush = async () => new Promise<void>((resolve) => setImmediate(resolve));

describe('DownloadQueue (property)', () => {
  it('deduplicates identical requests and keeps distinct ones', () => {
    fc.assert(
      fc.property(fc.array(fc.string({ minLength: 1, maxLength: 6 }), { maxLength: 30 }), (ids) => {
        const queue = new DownloadQueue({
          maxConcurrent: 2,
          maxAttempts: 1,
          spawnFn: () =>
            Object.assign(new EventEmitter(), {
              stdout: new EventEmitter(),
              stderr: new EventEmitter(),
              kill: () => true,
            }),
          afterJob: async () => {},
        });
        queue.clear();

        const unique = [...new Set(ids)];
        const jobs = queue.enqueue(
          unique.map((videoId) => ({
            folderPath: '/videos/a',
            videoId,
            videoUrl: `https://yt/${videoId}`,
            type: 'download',
          }))
        );
        const repeated = queue.enqueue(
          ids.map((videoId) => ({
            folderPath: '/videos/a',
            videoId,
            videoUrl: `https://yt/${videoId}`,
            type: 'download',
          }))
        );

        expect(jobs).toHaveLength(unique.length);
        expect(repeated).toHaveLength(ids.length);
        expect(new Set(repeated.map((job) => job.id)).size).toBe(unique.length);
      })
    );
  });

  it('never runs two downloads of one folder at once, nor more than maxConcurrent processes', () => {
    fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.oneof(
            fc.record({
              op: fc.constant('enqueue' as const),
              videoId: fc.string({ minLength: 1, maxLength: 6 }),
              folder: fc.constantFrom('/videos/a', '/videos/b', '/videos/c'),
              type: fc.constantFrom('download' as const, 'update' as const),
            }),
            fc.record({ op: fc.constant('exit' as const), slot: fc.integer({ min: 0, max: 3 }) }),
            fc.record({ op: fc.constant('cancel-all' as const) })
          ),
          { minLength: 1, maxLength: 40 }
        ),
        async (ops: Op[]) => {
          const spawner = createFakeSpawner();
          const queue = new DownloadQueue({
            maxConcurrent: 2,
            maxConcurrentUpdates: 2,
            maxAttempts: 1,
            spawnFn: spawner.spawnFn,
            afterJob: async () => {},
          });
          queue.clear();

          for (const op of ops) {
            if (op.op === 'enqueue') {
              queue.enqueue([
                {
                  folderPath: op.folder,
                  videoId: op.videoId,
                  videoUrl: `https://yt/${op.videoId}`,
                  type: op.type,
                  ...(op.type === 'update' ? { baseName: op.videoId } : {}),
                },
              ]);
            } else if (op.op === 'exit') {
              spawner.exit(op.slot);
            } else {
              queue.cancelAll();
            }
            await flush();

            // downloads and updates have separate limits (2 + 2)
            expect(spawner.totalActive()).toBeLessThanOrEqual(4);
            expect(spawner.runningUpdates()).toBeLessThanOrEqual(2);
            for (const folder of ['/videos/a', '/videos/b', '/videos/c']) {
              expect(spawner.runningDownloads(folder)).toBeLessThanOrEqual(1);
            }
          }
        }
      )
    );
  });
});
