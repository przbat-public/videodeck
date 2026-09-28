import type { LibraryEvent } from '@videodeck/shared/api';

/**
 * The video library as the browser knows it, in one small store beside
 * `elasticsearchStatus.ts` instead of a context.
 *
 * Two things feed it: the `GET /api/events` stream (every frame carries the
 * whole folder list) and the `/api/health` poll, which carries the revision
 * alone and is what keeps a page honest when the stream cannot be opened at
 * all. Pages read the revision and re-read the data they render, so the folder
 * list keeps one source of truth on the server.
 *
 * The folder list here is the diff base for the frames, and nothing else: the
 * console renders drive state from `/api/status`, and the store deliberately
 * does not keep a second copy of it.
 */

export interface LibraryState {
  /** Revision of the newest snapshot this client has seen; 0 before any */
  revision: number;
  /**
   * Folders of the newest frame, empty while only the health poll has
   * answered. Kept as the base the next frame's change is computed against.
   */
  folders: string[];
}

const EMPTY_STATE: LibraryState = { revision: 0, folders: [] };

let state: LibraryState = EMPTY_STATE;

/**
 * Whether a frame has ever been accepted. The diff base exists only after one:
 * a page that has read the health answer and nothing else must not treat the
 * opening frame's whole folder list as "everything just arrived".
 */
let hasSnapshot = false;

const listeners = new Set<() => void>();
const frameListeners = new Set<(frame: LibraryEvent) => void>();

/**
 * Folders that arrived since the last clear. The notice renders them and the
 * announcer reads them out, so both surfaces share one list instead of each
 * keeping its own copy of what "just arrived" means.
 */
let arrivals: string[] = [];
const arrivalListeners = new Set<() => void>();

function emitArrivals(): void {
  for (const listener of arrivalListeners) {
    listener();
  }
}

/** Folders that arrived since the last clear, oldest arrival first */
export function getLibraryArrivals(): string[] {
  return arrivals;
}

export function subscribeLibraryArrivals(listener: () => void): () => void {
  arrivalListeners.add(listener);
  return () => {
    arrivalListeners.delete(listener);
  };
}

/** The operator has seen the arrival, or asked for the reindex it offers */
export function clearLibraryArrivals(): void {
  if (arrivals.length === 0) {
    return;
  }
  arrivals = [];
  emitArrivals();
}

/** Add what one frame brought, keeping the order and dropping repeats */
function rememberArrivals(added: readonly string[]): void {
  if (added.length === 0) {
    return;
  }
  const known = new Set(arrivals);
  const fresh = added.filter((folderPath) => !known.has(folderPath));
  if (fresh.length === 0) {
    return;
  }
  arrivals = [...arrivals, ...fresh];
  emitArrivals();
}

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

/**
 * Whether the next value tells the store anything it does not already hold.
 * A revision is a watermark, but the folders that ride along are not: the
 * health poll can report revision 7 before the stream's opening frame for
 * revision 7 arrives, and that frame still carries the folder list.
 */
function isSameLibrary(next: LibraryState): boolean {
  return (
    next.revision === state.revision &&
    next.folders.length === state.folders.length &&
    next.folders.every((folderPath, index) => folderPath === state.folders[index])
  );
}

function setState(next: LibraryState): void {
  if (isSameLibrary(next)) {
    return;
  }
  state = next;
  emit();
}

export function getLibraryState(): LibraryState {
  return state;
}

export function getLibraryRevision(): number {
  return state.revision;
}

/** Reactive read for `useSyncExternalStore`; notifies on every real move */
export function subscribeLibraryState(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Every accepted frame, with what it added and removed. The console's "a drive
 * arrived" notice needs the change itself, not the state it left behind.
 */
export function subscribeLibraryFrames(listener: (frame: LibraryEvent) => void): () => void {
  frameListeners.add(listener);
  return () => {
    frameListeners.delete(listener);
  };
}

/** Folders of `next` that `before` did not have */
function foldersAdded(before: ReadonlySet<string>, next: readonly string[]): string[] {
  return next.filter((folderPath) => !before.has(folderPath));
}

/**
 * The state one frame describes. A frame older than the watermark is stale.
 *
 * The change is computed here against the last frame this client accepted,
 * not taken from the frame: the server computes it against the last frame of
 * one connection, so a tab that let the stream go (hidden, a sleeping laptop,
 * a reconnect) comes back to an opening frame with no delta at all and would
 * never hear that a drive arrived meanwhile. The frame's own `added`/`removed`
 * stay part of the contract for other consumers and are overwritten here with
 * the change this client actually saw.
 */
export function applyLibraryFrame(frame: LibraryEvent): void {
  if (frame.revision < state.revision) {
    return;
  }
  const before = new Set(state.folders);
  const after = new Set(frame.folders);
  const described: LibraryEvent = {
    ...frame,
    added: hasSnapshot ? foldersAdded(before, frame.folders) : [],
    removed: hasSnapshot ? state.folders.filter((folderPath) => !after.has(folderPath)) : [],
  };
  hasSnapshot = true;
  setState({ revision: frame.revision, folders: [...frame.folders] });
  rememberArrivals(described.added ?? []);
  for (const listener of frameListeners) {
    listener(described);
  }
}

/**
 * The revision the health poll reports. It carries no folders, so it only
 * moves the watermark: the pages re-read what they render, and the next frame
 * fills the list in.
 */
export function applyLibraryRevision(revision: number): void {
  if (revision <= state.revision) {
    return;
  }
  setState({ ...state, revision });
}

/** Tests, and a page that wants to start from a clean slate */
export function resetLibraryState(): void {
  state = EMPTY_STATE;
  hasSnapshot = false;
  clearLibraryArrivals();
  emit();
}
