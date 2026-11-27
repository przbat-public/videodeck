import fs from 'node:fs';
import { Counter } from '@prometheus-io/client';
import { metricsRegistry } from '../metricsRegistry';
import { logger } from '../utils/logger';
import { describeError, LogThrottle } from '../utils/logThrottle';
import { watchDirectoriesFor } from './libraryScan';

/**
 * Noticing that the library moved, and asking for a new scan when it did.
 *
 * One watcher per process, created by `libraryState.ts` and re-armed every time
 * it publishes. Each handle is a plain watch on one directory whose entries
 * decide the folder list (watchDirectoriesFor in libraryScan.ts): the volume
 * directory a glob starts from, every drive a glob level matches below it, the
 * parent of a literal root, or the longest existing ancestor of one of those
 * while its drive is away. No channel folder is watched, so a running download
 * raises no event, and every event is debounced into a single reconcile.
 * Whether the platform delivers anything at all is not assumed, which is what
 * the backstop timer is for; it also catches a directory that becomes a
 * channel folder after it appeared, which no watched directory announces.
 *
 * Nothing here reads the snapshot: the caller hands over the roots to watch and
 * the function to call when something moved, which keeps this module free of a
 * cycle back into the state that published.
 */

/** A platform watcher, narrowed to what this module uses */
export interface LibraryWatchHandle {
  close(): void;
}

/** Injectable collaborators: tests never depend on inotify or on a real clock */
export interface LibraryWatchDeps {
  /** Defaults to a plain `fs.watch(dir, onChange)`, which hears the entries of `dir` only */
  readonly watch?: (dir: string, onChange: () => void) => LibraryWatchHandle;
  readonly debounceMs?: number;
  readonly backstopMs?: number;
}

/** Events inside this window collapse into one reconcile */
export const LIBRARY_WATCH_DEBOUNCE_MS = 300;

/** Longest a dropped event can go unnoticed: network shares deliver none */
export const LIBRARY_WATCH_BACKSTOP_MS = 60_000;

/** One line per window for a watcher that fails on every arm */
const WATCH_ERROR_LOG_WINDOW_MS = 30_000;

/** Refused arms plus errors an armed handle reports */
export const libraryWatchErrorsTotal = new Counter({
  name: 'library_watch_errors_total',
  help: 'Watcher arms and watch errors the library state has seen',
  registers: [metricsRegistry],
});

interface ArmedWatch {
  readonly target: string;
  readonly handle: LibraryWatchHandle;
}

/** What the state module gets back: re-arm on a moved target set, stop on shutdown */
export interface LibraryWatcher {
  /** Attach a watcher per target, but only when the target set moved */
  arm(roots: readonly string[]): void;
  /** Close every handle and drop both timers */
  stop(): void;
}

const watchErrorThrottle = new LogThrottle(WATCH_ERROR_LOG_WINDOW_MS);

function reportWatchError(target: string, error: unknown): void {
  libraryWatchErrorsTotal.inc();
  if (watchErrorThrottle.shouldLog()) {
    logger.warn(`Library watch failed on ${target}: ${describeError(error)}`);
  }
}

/**
 * The real watcher, plain on purpose. A recursive one covered a whole drive
 * from one handle, but it also heard every write of a running download, and
 * off macOS Node builds it from one watch per file and lists the directory
 * again, on the main thread, for every event in it: a channel folder with tens
 * of thousands of files paid that on each write. Each directory that decides
 * the list gets a handle of its own instead (watchTargets).
 */
function defaultWatch(dir: string, onChange: () => void): LibraryWatchHandle {
  const watcher = fs.watch(dir, () => onChange());
  watcher.on('error', (error: unknown) => {
    reportWatchError(dir, error);
  });
  return {
    close: () => {
      watcher.close();
    },
  };
}

/**
 * Directories worth watching for one set of roots: every directory whose
 * entries decide what one of them resolves to, once each. A glob over a volume
 * path watches that volume and each drive on it, and a root whose drive is away
 * watches the parent that is still there.
 */
function watchTargets(roots: readonly string[]): string[] {
  const targets = new Set<string>();
  for (const root of roots) {
    for (const directory of watchDirectoriesFor(root)) {
      targets.add(directory);
    }
  }
  return [...targets].sort();
}

/**
 * Open a watcher per target set, with one debounce timer and one backstop for
 * the lifetime of the returned handle.
 */
export function createLibraryWatcher(deps: LibraryWatchDeps, reconcile: () => Promise<void>): LibraryWatcher {
  const resolved: Required<LibraryWatchDeps> = {
    watch: deps.watch ?? defaultWatch,
    debounceMs: deps.debounceMs ?? LIBRARY_WATCH_DEBOUNCE_MS,
    backstopMs: deps.backstopMs ?? LIBRARY_WATCH_BACKSTOP_MS,
  };
  let armedWatches: ArmedWatch[] = [];
  let debounceTimer: NodeJS.Timeout | null = null;

  const closeArmedWatches = (): void => {
    for (const armed of armedWatches) {
      try {
        armed.handle.close();
      } catch {
        /* a handle that is already gone needs no closing */
      }
    }
    armedWatches = [];
  };

  /** One debounced reconcile: an event says something moved, never what it is */
  const scheduleReconcile = (): void => {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void reconcile();
    }, resolved.debounceMs);
  };

  const openWatch = (target: string): LibraryWatchHandle => {
    try {
      return resolved.watch(target, scheduleReconcile);
    } catch (error) {
      // Kept in the armed set on purpose: a failing arm must not be retried on
      // every publish, and the backstop still reconciles.
      reportWatchError(target, error);
      return {
        close: () => {
          /* the watcher never opened */
        },
      };
    }
  };

  const backstopTimer = setInterval(() => {
    void reconcile();
  }, resolved.backstopMs);
  // A missed event costs one minute, the process is not held open for it
  backstopTimer.unref();

  return {
    arm(roots: readonly string[]): void {
      const targets = watchTargets(roots);
      const current = armedWatches.map((armed) => armed.target);
      if (targets.length === current.length && targets.every((target, index) => target === current[index])) {
        return;
      }
      closeArmedWatches();
      armedWatches = targets.map((target) => ({ target, handle: openWatch(target) }));
      if (targets.length > 0) {
        logger.info(`Library watch: watching ${targets.join(', ')} (debounce ${resolved.debounceMs} ms)`);
      }
    },
    stop(): void {
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      clearInterval(backstopTimer);
      closeArmedWatches();
    },
  };
}
