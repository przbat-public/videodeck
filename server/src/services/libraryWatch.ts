import fs from 'node:fs';
import path from 'node:path';
import { Counter } from '@prometheus-io/client';
import { metricsRegistry } from '../metricsRegistry';
import { logger } from '../utils/logger';
import { describeError, LogThrottle } from '../utils/logThrottle';
import { hasGlobMagic, isDirectory } from './libraryScan';

/**
 * Noticing that the library moved, and asking for a new scan when it did.
 *
 * One watcher per process, created by `libraryState.ts` and re-armed every time
 * it publishes: the handles attach to the longest existing ancestor of each
 * configured root, so a glob over `/Volumes` is watched at `/Volumes` while a
 * drive is away, and every event is debounced into a single reconcile. Whether
 * the platform delivers anything at all is not assumed, which is what the
 * backstop timer is for.
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
  /** Defaults to `fs.watch(dir, { recursive: true }, onChange)` */
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
 * The real watcher. `recursive` is what makes one handle cover a whole drive:
 * a channel folder created two levels down still produces an event. Whether
 * the platform delivers anything at all is not assumed, which is what the
 * backstop is for.
 */
function defaultWatch(dir: string, onChange: () => void): LibraryWatchHandle {
  const watcher = fs.watch(dir, { recursive: true }, () => onChange());
  watcher.on('error', (error: unknown) => {
    reportWatchError(dir, error);
  });
  return {
    close: () => {
      watcher.close();
    },
  };
}

function longestExistingAncestor(root: string): string | null {
  let candidate = path.resolve(root);
  while (true) {
    if (!hasGlobMagic(candidate) && isDirectory(candidate)) {
      return candidate;
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) {
      return null;
    }
    candidate = parent;
  }
}

/**
 * Directories worth watching for one set of roots: the longest existing
 * ancestor of each. A glob root over a volume path watches that volume, and a
 * root whose drive is away watches the parent that is still there.
 */
function watchTargets(roots: readonly string[]): string[] {
  const targets = new Set<string>();
  for (const root of roots) {
    const target = longestExistingAncestor(root);
    if (target !== null) {
      targets.add(target);
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
