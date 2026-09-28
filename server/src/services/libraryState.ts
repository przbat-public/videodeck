import { Counter, Gauge } from '@prometheus-io/client';
import { metricsRegistry } from '../metricsRegistry';
import { logger } from '../utils/logger';
import { describeError } from '../utils/logThrottle';
import type { LibraryScan } from './libraryScan';
import { coversRoot, scanLibraryAsync, scanLibrarySync } from './libraryScan';
import type { LibraryWatchDeps, LibraryWatcher } from './libraryWatch';
import { createLibraryWatcher } from './libraryWatch';

/**
 * The video library as watched, versioned state: the single owner of the
 * folder list `VIDEOS_FOLDER_PATH` resolves to.
 *
 * The folders live on removable drives, so "what the library is" changes while
 * the process runs. This module holds one snapshot (roots, folders, unavailable
 * paths, revision) and keeps it honest: the scan itself lives in
 * `libraryScan.ts`, the timers and handles that notice a change live in
 * `libraryWatch.ts`, and everything that decides what the snapshot now is,
 * publishes it and tells the subscribers lives here.
 */

/** What the library is right now / at one revision */
export interface LibrarySnapshot {
  /** Configured roots, in the order they were written in the environment */
  readonly roots: readonly string[];
  /** Channel folders the roots resolve to right now, deduped */
  readonly folders: readonly string[];
  /** Configured or remembered folders that are not there right now, sorted */
  readonly unavailable: readonly string[];
  /** 0 before the first scan, then one per distinct change */
  readonly revision: number;
}

// Kept on this surface: `parseLibraryRoots` is how the config layer checks that
// the environment value is usable, and the watch types and constants describe
// what `startLibraryWatch` accepts.
export { parseLibraryRoots } from './libraryScan';
export type { LibraryWatchDeps, LibraryWatchHandle } from './libraryWatch';
export { LIBRARY_WATCH_BACKSTOP_MS, LIBRARY_WATCH_DEBOUNCE_MS, libraryWatchErrorsTotal } from './libraryWatch';

/** Message kept from the folder cache this module replaced */
const NO_FOLDER_MATCHED =
  'VIDEOS_FOLDER_PATH is set, but no folder matched right now (drive unmounted?). ' +
  'Search and downloads are unavailable until a configured folder appears.';

export const libraryRevisionGauge = new Gauge({
  name: 'library_revision',
  help: 'Revision of the video library snapshot, 0 before the first scan',
  registers: [metricsRegistry],
});

export const libraryFoldersGauge = new Gauge({
  name: 'library_folders',
  help: 'Channel folders the current library snapshot holds',
  registers: [metricsRegistry],
});

/** Revisions published after the first scan; a counter, like the `_total` name promises */
export const libraryChangesTotal = new Counter({
  name: 'library_changes_total',
  help: 'Library revisions published after the first scan',
  registers: [metricsRegistry],
});

// ---------------------------------------------------------------------------

let snapshot: LibrarySnapshot | null = null;

/** Raw environment value the current snapshot was built from */
let publishedRaw: string | null = null;

/** Every folder the library has been seen with, so a drive that leaves is remembered */
const seenFolders = new Set<string>();

const listeners = new Set<() => void>();

/** Raw `VIDEOS_FOLDER_PATH` of this moment; every call re-reads it */
function readRawFolderEnv(): string {
  return process.env.VIDEOS_FOLDER_PATH ?? '';
}
function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Tell every subscriber that the snapshot changed (never on the first scan) */
function notifyListeners(): void {
  for (const listener of [...listeners]) {
    listener();
  }
}

/**
 * Drop the remembered folders the configured roots can no longer produce. A
 * folder is remembered because a drive may come back, and what can come back is
 * what the roots of this moment could produce: the library root that
 * `VIDEOS_FOLDER_PATH=/videos` remembered before the environment moved on to
 * `/videos/*` is still on disk, so reporting it as an unplugged drive would be
 * a lie.
 */
function forgetUncoveredFolders(roots: readonly string[]): void {
  for (const folderPath of [...seenFolders]) {
    if (!roots.some((root) => coversRoot(folderPath, root))) {
      seenFolders.delete(folderPath);
    }
  }
}

/**
 * Install one scan as the current snapshot. The revision stays put when
 * nothing changed, so a listener that re-reads on every notification costs
 * nothing on a quiet library.
 */
function publish(scan: LibraryScan): void {
  const found = new Set(scan.folders);
  const previous = snapshot;
  if (previous !== null && !sameList(previous.roots, scan.roots)) {
    forgetUncoveredFolders(scan.roots);
  }
  for (const folderPath of scan.folders) {
    seenFolders.add(folderPath);
  }
  const unavailable = sortedUnique([
    ...scan.awayLiterals,
    ...[...seenFolders].filter((folderPath) => !found.has(folderPath)),
  ]);
  const changed =
    previous === null ||
    !sameList(previous.roots, scan.roots) ||
    !sameList(previous.folders, scan.folders) ||
    !sameList(previous.unavailable, unavailable);
  const revision = previous === null || changed ? (previous?.revision ?? 0) + 1 : previous.revision;

  const next: LibrarySnapshot = { roots: [...scan.roots], folders: [...scan.folders], unavailable, revision };
  snapshot = next;
  publishedRaw = scan.raw;
  libraryRevisionGauge.set(revision);
  libraryFoldersGauge.set(next.folders.length);

  if (changed && next.roots.length > 0 && next.folders.length === 0) {
    logger.warn(NO_FOLDER_MATCHED);
  }
  if (previous !== null && changed) {
    libraryChangesTotal.inc();
    notifyListeners();
  }
  armWatch();
}

/**
 * The snapshot of this moment. The first call, or one after the raw value
 * changed, scans synchronously: that is the cold-boot read the config callers
 * have always done, and it is the only synchronous scan in this module.
 */
function ensureSnapshot(): LibrarySnapshot {
  const raw = readRawFolderEnv();
  if (snapshot === null || publishedRaw !== raw) {
    publish(scanLibrarySync(raw));
  }
  const current = snapshot;
  if (current === null) {
    // publish() always leaves one behind; the guard keeps the type honest
    throw new Error('Library snapshot was not published');
  }
  return current;
}

// ---------------------------------------------------------------------------
// The public surface
// ---------------------------------------------------------------------------

/** The current snapshot; the first call scans (see ensureSnapshot) */
export function getLibrarySnapshot(): LibrarySnapshot {
  return ensureSnapshot();
}

/** Revision of the current snapshot, 0 before the first scan */
export function getLibraryRevision(): number {
  return ensureSnapshot().revision;
}

/**
 * Called after every published change (never for the first scan, which has
 * nothing to invalidate). Returns the unsubscribe function.
 */
export function subscribeLibraryChanges(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

let reconcileInFlight: Promise<void> | null = null;

/** A caller arrived mid-scan, so one more pass is owed once it finishes */
let reconcileOwed = false;

/**
 * Re-read the disk and publish what it found. One at a time: a burst of
 * events, the backstop and a config read landing together still cost one
 * scan, and the callers that arrive during it share its promise.
 *
 * A caller that arrives while a scan runs is a change the running scan may
 * have read the disk before, so it is owed one more pass. Without it that
 * change would wait for the backstop, up to a minute.
 */
export function reconcileLibrary(): Promise<void> {
  if (reconcileInFlight !== null) {
    reconcileOwed = true;
    return reconcileInFlight;
  }
  const run = scanLibraryAsync(readRawFolderEnv())
    .then((scan) => {
      publish(scan);
    })
    .catch((error: unknown) => {
      logger.warn(`Library reconcile failed: ${describeFailure(error)}`);
    })
    .finally(() => {
      reconcileInFlight = null;
      if (reconcileOwed) {
        reconcileOwed = false;
        void reconcileLibrary();
      }
    });
  reconcileInFlight = run;
  return run;
}

/**
 * Resolve once no reconcile is running and none is owed. Tests call it before
 * they tear a tree down: a scan that is still in flight publishes after the
 * test that started it, and that publish would land in the next one. The
 * trailing pass a caller may have triggered is awaited too, so the promise
 * settling means the module is quiet.
 */
export async function whenLibraryIdle(): Promise<void> {
  while (reconcileInFlight !== null) {
    const running = reconcileInFlight;
    await running;
  }
}

/**
 * Forget the snapshot and the memory of what the library held (tests, config
 * reloads). The watcher stays armed: the next publish re-arms it if the roots
 * moved.
 */
export function resetLibraryState(): void {
  snapshot = null;
  publishedRaw = null;
  seenFolders.clear();
}

// ---------------------------------------------------------------------------
// Watching
// ---------------------------------------------------------------------------

/** The watcher of this moment; null until `startLibraryWatch` opens one */
let watcher: LibraryWatcher | null = null;

/** Re-arm after a publish, so a drive that appeared is watched where it is */
function armWatch(): void {
  const current = snapshot;
  if (watcher === null || current === null) {
    return;
  }
  watcher.arm(current.roots);
}

/**
 * Watch the roots until `stopLibraryWatch`. Safe to call when the library is
 * unusable right now: nothing is armed, and the backstop picks the roots up
 * as soon as a scan finds them.
 */
export function startLibraryWatch(deps: LibraryWatchDeps = {}): void {
  stopLibraryWatch();
  watcher = createLibraryWatcher(deps, reconcileLibrary);
  try {
    ensureSnapshot();
  } catch (error) {
    // An unusable VIDEOS_FOLDER_PATH is a boot error the config callers own
    logger.warn(`Library watch started without a folder list: ${describeError(error)}`);
  }
  armWatch();
}

/** Close every handle and drop both timers; the snapshot stays as it is */
export function stopLibraryWatch(): void {
  watcher?.stop();
  watcher = null;
}
