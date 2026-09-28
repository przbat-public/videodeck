import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { metricsRegistry } from '../metricsRegistry';
import type { LibraryWatchDeps } from './libraryState';
import {
  getLibrarySnapshot,
  LIBRARY_WATCH_BACKSTOP_MS,
  LIBRARY_WATCH_DEBOUNCE_MS,
  reconcileLibrary,
  resetLibraryState,
  startLibraryWatch,
  stopLibraryWatch,
  subscribeLibraryChanges,
} from './libraryState';

/**
 * The library as watched state: the folder list a glob root resolves to, the
 * revision it carries, and the watcher that keeps both honest while the app
 * runs.
 *
 * Every test works on temp directories it creates, and none of them talks to
 * inotify: the watch factory is injected, so an event is a call the test makes
 * and the clock is a fake one it advances. What is left to the platform is
 * real event coalescing and error delivery, neither of which the service
 * relies on (the reconcile decides, the backstop covers a dropped event).
 */

/** Put an environment variable back the way this file found it */
function restoreEnv(name: string, original: string | undefined): void {
  if (original === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = original;
  }
}

/** One real macrotask turn, so pending fs work can land under fake timers */
const flushAsync = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Real loop turns a scan that should not have started is given to reach the disk */
const SETTLE_TURNS = 50;

/**
 * Fake timers stop the service's own clock, not the thread pool, so a scan an
 * implementation started anyway needs real loop turns before it reads a
 * directory. Polls a predicate instead of sleeping for a fixed duration.
 */
async function settleUntil(predicate: () => boolean): Promise<void> {
  for (let turn = 0; turn < SETTLE_TURNS && !predicate(); turn += 1) {
    await flushAsync();
  }
}

/**
 * Real loop turns for a pass the service started on its own. Waiting on the
 * filesystem boundary alone proves a scan began, not that it published, and a
 * publish landing after the test would reach into the next one.
 */
async function drainTurns(): Promise<void> {
  for (let turn = 0; turn < SETTLE_TURNS; turn += 1) {
    await flushAsync();
  }
}

/** A channel folder on a (fake) drive: a directory yt-dlp has already written into */
function makeChannelFolder(dir: string, name: string): string {
  const folderPath = path.join(dir, name);
  fs.mkdirSync(folderPath, { recursive: true });
  fs.writeFileSync(path.join(folderPath, 'config.json'), '{}');
  return folderPath;
}

interface FakeWatch {
  /** Directories the service armed, in order */
  readonly watched: string[];
  /** Directories whose handle was closed */
  readonly closed: string[];
  readonly deps: LibraryWatchDeps;
  /** Deliver one change event to every armed watcher */
  emit(): void;
}

/**
 * Stand-in for `fs.watch`. It models the two things the service depends on,
 * which directory was armed and which callback belongs to it, plus the refusal
 * a missing ancestor produces. Whether the kernel coalesces two writes into
 * one event is not modelled, because the debounce and the reconcile make that
 * irrelevant.
 */
function fakeWatch(options: { failFor?: (dir: string) => boolean } = {}): FakeWatch {
  const callbacks = new Map<string, () => void>();
  const watched: string[] = [];
  const closed: string[] = [];
  return {
    watched,
    closed,
    deps: {
      watch: (dir, onChange) => {
        if (options.failFor?.(dir) === true) {
          throw new Error(`watch refused: ${dir}`);
        }
        watched.push(dir);
        callbacks.set(dir, onChange);
        return {
          close: () => {
            callbacks.delete(dir);
            closed.push(dir);
          },
        };
      },
    },
    emit: () => {
      for (const onChange of [...callbacks.values()]) {
        onChange();
      }
    },
  };
}

/** Metric value, read the way elasticsearchService.test.ts reads its gauge */
async function gaugeValue(name: string): Promise<number> {
  const gauge = metricsRegistry.getSingleMetric(name) as {
    get: () => Promise<{ values: Array<{ value: number }> }>;
  };
  return (await gauge.get()).values[0]?.value ?? Number.NaN;
}

describe('libraryState', () => {
  const originalFolderPath = process.env.VIDEOS_FOLDER_PATH;
  const originalLogLevel = process.env.LOG_LEVEL;
  const cleanups: Array<() => void> = [];
  let base: string;

  /** Revisions the service published since the call, plus the next one as a promise */
  function libraryChangeLog(): { revisions: number[]; next: () => Promise<number> } {
    const revisions: number[] = [];
    const waiters: Array<(revision: number) => void> = [];
    cleanups.push(
      subscribeLibraryChanges(() => {
        const revision = getLibrarySnapshot().revision;
        revisions.push(revision);
        for (const resolve of waiters.splice(0)) {
          resolve(revision);
        }
      }),
    );
    return {
      revisions,
      next: () => new Promise<number>((resolve) => waiters.push(resolve)),
    };
  }

  beforeEach(() => {
    // The "no folder matched" and watcher lines are assertions of their own
    // tests; everything else runs without log noise.
    process.env.LOG_LEVEL = 'error';
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'library-state-'));
    resetLibraryState();
  });

  afterEach(() => {
    stopLibraryWatch();
    resetLibraryState();
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
    jest.useRealTimers();
    jest.restoreAllMocks();
    restoreEnv('VIDEOS_FOLDER_PATH', originalFolderPath);
    restoreEnv('LOG_LEVEL', originalLogLevel);
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('publishes the folders of a glob root on the first scan with revision 1', async () => {
    const channelA = makeChannelFolder(base, 'kanal-a');
    const channelB = makeChannelFolder(base, 'kanal-b');
    fs.mkdirSync(path.join(base, 'not-a-channel')); // no config.json, no *.info.json
    process.env.VIDEOS_FOLDER_PATH = `${base}/*`;

    const snapshot = getLibrarySnapshot();

    expect(snapshot.roots).toEqual([`${base}/*`]);
    expect(snapshot.folders).toEqual([channelA, channelB]);
    expect(snapshot.unavailable).toEqual([]);
    expect(snapshot.revision).toBe(1);
    expect(await gaugeValue('library_revision')).toBe(1);
    expect(await gaugeValue('library_folders')).toBe(2);
  });

  it('bumps the revision once and notifies subscribers when a folder appears under a watched root', async () => {
    jest.useFakeTimers();
    const channelA = makeChannelFolder(base, 'kanal-a');
    process.env.VIDEOS_FOLDER_PATH = `${base}/*`;
    const fake = fakeWatch();
    startLibraryWatch(fake.deps);
    const changes = libraryChangeLog();
    const changesBefore = await gaugeValue('library_changes_total');

    const channelB = makeChannelFolder(base, 'kanal-b'); // the drive arrives
    const changed = changes.next();
    fake.emit();
    await jest.advanceTimersByTimeAsync(LIBRARY_WATCH_DEBOUNCE_MS);
    await changed;

    expect(getLibrarySnapshot().folders).toEqual([channelA, channelB]);
    expect(getLibrarySnapshot().revision).toBe(2);
    expect(changes.revisions).toEqual([2]);
    expect(await gaugeValue('library_changes_total')).toBe(changesBefore + 1);
    expect(await gaugeValue('library_revision')).toBe(2);
  });

  it('collapses a burst of events inside the debounce window into one reconcile', async () => {
    // setImmediate stays real so the test can give an (incorrect) immediate
    // scan every chance to reach the disk before the window has closed.
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    const channelA = makeChannelFolder(base, 'kanal-a');
    process.env.VIDEOS_FOLDER_PATH = `${base}/*`;
    const fake = fakeWatch();
    startLibraryWatch(fake.deps);
    const changes = libraryChangeLog();
    const readdir = jest.spyOn(fsPromises, 'readdir');
    const scansOfTheRoot = (): number => readdir.mock.calls.filter(([dir]) => dir === base).length;

    const channelB = makeChannelFolder(base, 'kanal-b');
    const changed = changes.next();
    fake.emit();
    await jest.advanceTimersByTimeAsync(LIBRARY_WATCH_DEBOUNCE_MS - 1);
    await settleUntil(() => scansOfTheRoot() > 0);
    // The event only opened the window: the disk has not been read yet
    expect(scansOfTheRoot()).toBe(0);

    const channelC = makeChannelFolder(base, 'kanal-c'); // the burst continues
    fake.emit();
    await jest.advanceTimersByTimeAsync(LIBRARY_WATCH_DEBOUNCE_MS);
    await changed;

    // One scan for the whole burst, and it saw everything the burst brought
    expect(scansOfTheRoot()).toBe(1);
    expect(getLibrarySnapshot().folders).toEqual([channelA, channelB, channelC]);
    expect(changes.revisions).toEqual([2]);
  });

  it('scans again when a change lands while a reconcile is already running', async () => {
    // setImmediate stays real so the test can give a trailing scan the loop
    // turns it needs to reach the disk.
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    const channelA = makeChannelFolder(base, 'kanal-a');
    process.env.VIDEOS_FOLDER_PATH = `${base}/*`;
    startLibraryWatch(fakeWatch().deps);
    getLibrarySnapshot();
    const readdir = jest.spyOn(fsPromises, 'readdir');
    const scansOfTheRoot = (): number => readdir.mock.calls.filter(([dir]) => dir === base).length;

    // The folder lands between the running scan's read and its publish, so the
    // snapshot that scan installs is already one change behind. Without a
    // trailing pass the change waits for the backstop, up to a minute.
    const channelB = makeChannelFolder(base, 'kanal-b');
    const running = reconcileLibrary();
    const duringTheScan = reconcileLibrary();
    await Promise.all([running, duringTheScan]);
    await settleUntil(() => scansOfTheRoot() >= 2);
    // Let the trailing pass publish before the tree goes away, so it cannot
    // land in the next test as a snapshot of a folder that no longer exists.
    await drainTurns();

    expect(scansOfTheRoot()).toBe(2);
    expect(getLibrarySnapshot().folders).toEqual([channelA, channelB]);
  });

  it('reconciles inside the backstop window when the watcher stays silent', async () => {
    jest.useFakeTimers();
    const channelA = makeChannelFolder(base, 'kanal-a');
    process.env.VIDEOS_FOLDER_PATH = `${base}/*`;
    const fake = fakeWatch();
    startLibraryWatch(fake.deps);
    const changes = libraryChangeLog();

    const channelB = makeChannelFolder(base, 'kanal-b'); // no event ever arrives for it
    const changed = changes.next();
    await jest.advanceTimersByTimeAsync(LIBRARY_WATCH_BACKSTOP_MS);
    await changed;

    expect(fake.watched).toEqual([base]);
    expect(getLibrarySnapshot().folders).toEqual([channelA, channelB]);
    expect(getLibrarySnapshot().revision).toBe(2);
  });

  it('keeps the revision when a rescan finds the same folders', async () => {
    const channelA = makeChannelFolder(base, 'kanal-a');
    process.env.VIDEOS_FOLDER_PATH = `${base}/*`;
    startLibraryWatch(fakeWatch().deps);
    const changes = libraryChangeLog();

    await reconcileLibrary();
    await reconcileLibrary();

    expect(getLibrarySnapshot().folders).toEqual([channelA]);
    expect(getLibrarySnapshot().revision).toBe(1);
    expect(changes.revisions).toEqual([]);
  });

  it('keeps a folder whose drive went away as unavailable', async () => {
    jest.useFakeTimers();
    const channelA = makeChannelFolder(base, 'kanal-a');
    const channelB = makeChannelFolder(base, 'kanal-b');
    process.env.VIDEOS_FOLDER_PATH = `${base}/*`;
    const fake = fakeWatch();
    startLibraryWatch(fake.deps);
    const changes = libraryChangeLog();
    expect(getLibrarySnapshot().folders).toEqual([channelA, channelB]);

    fs.rmSync(channelB, { recursive: true }); // the drive with kanal-b leaves
    const changed = changes.next();
    fake.emit();
    await jest.advanceTimersByTimeAsync(LIBRARY_WATCH_DEBOUNCE_MS);
    await changed;

    const snapshot = getLibrarySnapshot();
    expect(snapshot.folders).toEqual([channelA]);
    expect(snapshot.unavailable).toEqual([channelB]);
    expect(snapshot.revision).toBe(2);

    // The path is remembered, not dropped: the drive may come back
    makeChannelFolder(base, 'kanal-b');
    const returned = changes.next();
    fake.emit();
    await jest.advanceTimersByTimeAsync(LIBRARY_WATCH_DEBOUNCE_MS);
    await returned;
    expect(getLibrarySnapshot().folders).toEqual([channelA, channelB]);
    expect(getLibrarySnapshot().unavailable).toEqual([]);
  });

  it('reports a literal entry that is not there as unavailable', async () => {
    const away = path.join(base, 'disk-a', 'kanal-a'); // the drive is away
    process.env.VIDEOS_FOLDER_PATH = away;

    expect(getLibrarySnapshot().folders).toEqual([away]); // callers keep resolving it
    expect(getLibrarySnapshot().unavailable).toEqual([away]);

    fs.mkdirSync(away, { recursive: true }); // the drive comes back
    await reconcileLibrary();

    expect(getLibrarySnapshot().unavailable).toEqual([]);
  });

  it('counts a watch error and keeps the backstop reconcile running', async () => {
    jest.useFakeTimers();
    process.env.LOG_LEVEL = 'warn';
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {
      /* the counted watcher line is the assertion */
    });
    const channelA = makeChannelFolder(base, 'kanal-a');
    const otherDrive = path.join(base, 'other-drive');
    makeChannelFolder(otherDrive, 'kanal-b');
    process.env.VIDEOS_FOLDER_PATH = `${base}/*;${otherDrive}/*`;
    const errorsBefore = await gaugeValue('library_watch_errors_total');

    startLibraryWatch({ ...fakeWatch({ failFor: () => true }).deps });
    const changes = libraryChangeLog();

    // Two refused targets, one line: the second failure is inside the window
    expect(await gaugeValue('library_watch_errors_total')).toBe(errorsBefore + 2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('Library watch failed on');

    const channelC = makeChannelFolder(base, 'kanal-c');
    const changed = changes.next();
    await jest.advanceTimersByTimeAsync(LIBRARY_WATCH_BACKSTOP_MS);
    await changed;

    expect(getLibrarySnapshot().folders).toEqual([channelA, path.join(otherDrive, 'kanal-b'), channelC].sort());
  });

  it('watches the longest existing ancestor of a root', () => {
    process.env.VIDEOS_FOLDER_PATH = `${base}/disk-a/*`; // the drive is away
    const awayDrive = fakeWatch();
    startLibraryWatch(awayDrive.deps);
    expect(awayDrive.watched).toEqual([base]);

    stopLibraryWatch();
    resetLibraryState();
    makeChannelFolder(base, path.join('disk-a', 'kanal-a')); // the drive appears
    const mountedDrive = fakeWatch();
    startLibraryWatch(mountedDrive.deps);
    expect(mountedDrive.watched).toEqual([path.join(base, 'disk-a')]);

    stopLibraryWatch();
    resetLibraryState();
    process.env.VIDEOS_FOLDER_PATH = path.join(base, 'disk-b', 'kanal-b');
    const literalAway = fakeWatch();
    startLibraryWatch(literalAway.deps);
    expect(literalAway.watched).toEqual([base]);
  });

  it('re-arms the watcher on the new roots when the environment changes', async () => {
    jest.useFakeTimers();
    const otherBase = path.join(base, 'other');
    makeChannelFolder(base, 'kanal-a');
    makeChannelFolder(otherBase, 'kanal-b');
    process.env.VIDEOS_FOLDER_PATH = `${base}/*`;
    const fake = fakeWatch();
    startLibraryWatch(fake.deps);
    const changes = libraryChangeLog();
    expect(fake.watched).toEqual([base]);

    process.env.VIDEOS_FOLDER_PATH = `${otherBase}/*`;
    const changed = changes.next();
    await jest.advanceTimersByTimeAsync(LIBRARY_WATCH_BACKSTOP_MS);
    await changed;

    expect(getLibrarySnapshot().roots).toEqual([`${otherBase}/*`]);
    expect(fake.closed).toEqual([base]);
    expect(fake.watched).toEqual([base, otherBase]);
  });
});
