import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Counter, Gauge } from '@prometheus-io/client';
import { metricsRegistry } from '../metricsRegistry';
import { logger } from '../utils/logger';
import { LogThrottle } from '../utils/logThrottle';

/**
 * The video library as watched, versioned state: the single owner of the
 * folder list `VIDEOS_FOLDER_PATH` resolves to.
 *
 * The folders live on removable drives, so "what the library is" changes while
 * the process runs. This module holds one snapshot (roots, folders, unavailable
 * paths, revision) and keeps it honest three ways: a synchronous scan on the
 * first read, a debounced scan after any watcher event, and a backstop scan
 * every minute for the events `fs.watch` drops (network shares deliver none at
 * all). Only a scan ever writes the snapshot; an event merely says that
 * something moved.
 *
 * The watcher attaches to the longest existing ancestor of every root, so a
 * glob root over `/Volumes` is watched at `/Volumes` while a drive is away and
 * moves closer as the drive appears. A folder that leaves the library stays in
 * `unavailable`, which is what lets a page say "drive unplugged" instead of
 * showing an empty channel.
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

/** Refused watcher arms plus errors delivered by an armed handle */
export const libraryWatchErrorsTotal = new Counter({
  name: 'library_watch_errors_total',
  help: 'Watcher arms and watch errors the library state has seen',
  registers: [metricsRegistry],
});

// ---------------------------------------------------------------------------
// Snapshot state
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

// ---------------------------------------------------------------------------
// Parsing and glob expansion
// ---------------------------------------------------------------------------

/** `~/…` → the absolute home path (so ~-paths work in .env like in a shell) */
function expandTilde(entry: string): string {
  if (entry === '~') {
    return os.homedir();
  }
  if (entry.startsWith('~/')) {
    return path.join(os.homedir(), entry.slice(2));
  }
  return entry;
}

/**
 * Roots of one raw `VIDEOS_FOLDER_PATH`: split on `;` or `,`, trimmed, `~/`
 * expanded, duplicates dropped, in the order they were written.
 */
export function parseLibraryRoots(raw: string): string[] {
  const roots: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw.split(/[;,]/)) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const expanded = expandTilde(trimmed);
    if (!seen.has(expanded)) {
      seen.add(expanded);
      roots.push(expanded);
    }
  }
  return roots;
}

function hasGlobMagic(value: string): boolean {
  return value.includes('*');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

/** `drone-*` → `^drone-[^/]*$` (`*` matches within one path segment only) */
function globSegmentToRegExp(segment: string): RegExp {
  const source = segment.split('*').map(escapeRegExp).join('[^/]*');
  return new RegExp(`^${source}$`);
}

/** Direct subdirectory names; [] when unreadable */
function listDirectories(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** Directories matched by one pattern segment below the given bases */
function expandSegment(segment: string, bases: readonly string[]): string[] {
  const next: string[] = [];
  if (segment.includes('*')) {
    const matcher = globSegmentToRegExp(segment);
    for (const base of bases) {
      for (const name of listDirectories(base)) {
        if (matcher.test(name)) {
          next.push(path.join(base, name));
        }
      }
    }
    return next;
  }
  for (const base of bases) {
    const candidate = path.join(base, segment);
    if (isDirectory(candidate)) {
      next.push(candidate);
    }
  }
  return next;
}

/**
 * Expand a path pattern whose segments may contain `*` (one level each, no
 * `**`). Only existing directories are returned, walking the literal segments
 * first so a pattern rooted at a volume path never descends into a volume
 * that is not mounted.
 */
function expandGlob(pattern: string): string[] {
  const segments = pattern.split('/').filter((segment) => segment.length > 0);
  let current = [pattern.startsWith('/') ? '/' : '.'];
  for (const segment of segments) {
    current = expandSegment(segment, current);
    if (current.length === 0) {
      return [];
    }
  }
  return current;
}

/**
 * Whether a directory looks like a channel folder: it holds a `config.json`
 * or at least one `*.info.json` directly (yt-dlp writes both into the folder
 * it downloads into). This is what lets a wildcard over a volume's entries
 * match channel folders but skip unrelated directories of other volumes.
 */
function isChannelFolder(folderPath: string): boolean {
  try {
    return fs
      .readdirSync(folderPath, { withFileTypes: true })
      .some((entry) => entry.isFile() && (entry.name === 'config.json' || entry.name.endsWith('.info.json')));
  } catch {
    return false;
  }
}

/** Direct subdirectory names via async fs; [] when unreadable */
async function listDirectoriesAsync(dir: string): Promise<string[]> {
  try {
    const entries = await fsPromises.readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function isDirectoryAsync(dir: string): Promise<boolean> {
  try {
    return (await fsPromises.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

async function isChannelFolderAsync(folderPath: string): Promise<boolean> {
  try {
    const entries = await fsPromises.readdir(folderPath, { withFileTypes: true });
    return entries.some(
      (entry) => entry.isFile() && (entry.name === 'config.json' || entry.name.endsWith('.info.json')),
    );
  } catch {
    return false;
  }
}

/** Directories matched by one pattern segment below the given bases (async) */
async function expandSegmentAsync(segment: string, bases: readonly string[]): Promise<string[]> {
  const next: string[] = [];
  if (segment.includes('*')) {
    const matcher = globSegmentToRegExp(segment);
    for (const base of bases) {
      for (const name of await listDirectoriesAsync(base)) {
        if (matcher.test(name)) {
          next.push(path.join(base, name));
        }
      }
    }
    return next;
  }
  for (const base of bases) {
    const candidate = path.join(base, segment);
    if (await isDirectoryAsync(candidate)) {
      next.push(candidate);
    }
  }
  return next;
}

async function expandGlobAsync(pattern: string): Promise<string[]> {
  const segments = pattern.split('/').filter((segment) => segment.length > 0);
  let current = [pattern.startsWith('/') ? '/' : '.'];
  for (const segment of segments) {
    current = await expandSegmentAsync(segment, current);
    if (current.length === 0) {
      return [];
    }
  }
  return current;
}

// ---------------------------------------------------------------------------
// Scanning and publishing
// ---------------------------------------------------------------------------

interface LibraryScan {
  readonly raw: string;
  readonly roots: readonly string[];
  readonly folders: readonly string[];
  /** Literal roots that are not a directory right now (a drive that is away) */
  readonly awayLiterals: readonly string[];
}

/** Push a folder once, keeping the order the roots were written in */
function pushFolder(folders: string[], seen: Set<string>, folderPath: string): void {
  if (!seen.has(folderPath)) {
    seen.add(folderPath);
    folders.push(folderPath);
  }
}

/**
 * The scan of the cold-boot read. A literal root is kept whatever the disk
 * says, exactly as the folder cache this module replaced did: callers such as
 * the queue have to keep resolving a folder on a drive that is away, and
 * `unavailable` is what marks it.
 */
function scanLibrarySync(raw: string): LibraryScan {
  const roots = parseLibraryRoots(raw);
  const folders: string[] = [];
  const awayLiterals: string[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    if (hasGlobMagic(root)) {
      for (const folderPath of expandGlob(root).filter(isChannelFolder).sort()) {
        pushFolder(folders, seen, folderPath);
      }
      continue;
    }
    if (!isDirectory(root)) {
      awayLiterals.push(root);
    }
    pushFolder(folders, seen, root);
  }
  return { raw, roots, folders, awayLiterals };
}

/** The same scan off the event loop, for anything that is not the cold boot */
async function scanLibraryAsync(raw: string): Promise<LibraryScan> {
  const roots = parseLibraryRoots(raw);
  const folders: string[] = [];
  const awayLiterals: string[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    if (hasGlobMagic(root)) {
      const candidates = await expandGlobAsync(root);
      const matched: string[] = [];
      for (const folderPath of candidates) {
        if (await isChannelFolderAsync(folderPath)) {
          matched.push(folderPath);
        }
      }
      for (const folderPath of matched.sort()) {
        pushFolder(folders, seen, folderPath);
      }
      continue;
    }
    if (!(await isDirectoryAsync(root))) {
      awayLiterals.push(root);
    }
    pushFolder(folders, seen, root);
  }
  return { raw, roots, folders, awayLiterals };
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
 * Install one scan as the current snapshot. The revision stays put when
 * nothing changed, so a listener that re-reads on every notification costs
 * nothing on a quiet library.
 */
function publish(scan: LibraryScan): void {
  const found = new Set(scan.folders);
  for (const folderPath of scan.folders) {
    seenFolders.add(folderPath);
  }
  const unavailable = sortedUnique([
    ...scan.awayLiterals,
    ...[...seenFolders].filter((folderPath) => !found.has(folderPath)),
  ]);
  const previous = snapshot;
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

type WatchFn = (dir: string, onChange: () => void) => LibraryWatchHandle;

interface ArmedWatch {
  readonly target: string;
  readonly handle: LibraryWatchHandle;
}

let watchDeps: Required<LibraryWatchDeps> | null = null;
let armedWatches: ArmedWatch[] = [];
let debounceTimer: NodeJS.Timeout | null = null;
let backstopTimer: NodeJS.Timeout | null = null;

const watchErrorThrottle = new LogThrottle(WATCH_ERROR_LOG_WINDOW_MS);

function reportWatchError(target: string, error: unknown): void {
  libraryWatchErrorsTotal.inc();
  if (watchErrorThrottle.shouldLog()) {
    logger.warn(`Library watch failed on ${target}: ${describeFailure(error)}`);
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

function openWatch(target: string, watch: WatchFn): LibraryWatchHandle {
  try {
    return watch(target, scheduleReconcile);
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

function closeArmedWatches(): void {
  for (const armed of armedWatches) {
    try {
      armed.handle.close();
    } catch {
      /* a handle that is already gone needs no closing */
    }
  }
  armedWatches = [];
}

/**
 * Attach a watcher per target, but only when the target set moved: a reconcile
 * that finds the same library touches no handle.
 */
function armWatch(): void {
  const deps = watchDeps;
  const current = snapshot;
  if (deps === null || current === null) {
    return;
  }
  const targets = watchTargets(current.roots);
  if (
    sameList(
      targets,
      armedWatches.map((armed) => armed.target),
    )
  ) {
    return;
  }
  closeArmedWatches();
  armedWatches = targets.map((target) => ({ target, handle: openWatch(target, deps.watch) }));
  if (targets.length > 0) {
    logger.info(`Library watch: watching ${targets.join(', ')} (debounce ${deps.debounceMs} ms)`);
  }
}

/** One debounced reconcile: an event says something moved, never what it is */
function scheduleReconcile(): void {
  const deps = watchDeps;
  if (deps === null) {
    return;
  }
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
  }
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void reconcileLibrary();
  }, deps.debounceMs);
}

/**
 * Watch the roots until `stopLibraryWatch`. Safe to call when the library is
 * unusable right now: nothing is armed, and the backstop picks the roots up
 * as soon as a scan finds them.
 */
export function startLibraryWatch(deps: LibraryWatchDeps = {}): void {
  stopLibraryWatch();
  const resolved: Required<LibraryWatchDeps> = {
    watch: deps.watch ?? defaultWatch,
    debounceMs: deps.debounceMs ?? LIBRARY_WATCH_DEBOUNCE_MS,
    backstopMs: deps.backstopMs ?? LIBRARY_WATCH_BACKSTOP_MS,
  };
  watchDeps = resolved;
  try {
    ensureSnapshot();
  } catch (error) {
    // An unusable VIDEOS_FOLDER_PATH is a boot error the config callers own
    logger.warn(`Library watch started without a folder list: ${describeFailure(error)}`);
  }
  armWatch();
  backstopTimer = setInterval(() => {
    void reconcileLibrary();
  }, resolved.backstopMs);
  // A missed event costs one minute, the process is not held open for it
  backstopTimer.unref();
}

/** Close every handle and drop both timers; the snapshot stays as it is */
export function stopLibraryWatch(): void {
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (backstopTimer !== null) {
    clearInterval(backstopTimer);
    backstopTimer = null;
  }
  closeArmedWatches();
  watchDeps = null;
}
