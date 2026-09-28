import type { LibraryEvent } from '@videodeck/shared/api';

/**
 * The video library as the browser knows it, in one small store beside
 * `elasticsearchStatus.ts` instead of a context.
 *
 * Two things feed it: the `GET /api/events` stream (the opening frame carries
 * the whole library, later frames say what moved) and the `/api/health` poll,
 * which carries the revision alone and is what keeps a page honest when the
 * stream cannot be opened at all. Pages do not render this state yet: they
 * read the revision and re-read the data they render, so the folder list keeps
 * one source of truth on the server.
 */

export interface LibraryState {
  /** Revision of the newest snapshot this client has seen; 0 before any */
  revision: number;
  /** Folders of the newest frame; empty when only the health poll answered */
  folders: string[];
  /** Folders that were configured or seen before and are missing right now */
  unavailable: string[];
  /** Whether a stream is currently connected; false is a degraded page */
  streamOpen: boolean;
}

const EMPTY_STATE: LibraryState = { revision: 0, folders: [], unavailable: [], streamOpen: false };

let state: LibraryState = EMPTY_STATE;
const listeners = new Set<() => void>();
const frameListeners = new Set<(frame: LibraryEvent) => void>();

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
    next.streamOpen === state.streamOpen &&
    next.folders.length === state.folders.length &&
    next.folders.every((folderPath, index) => folderPath === state.folders[index]) &&
    next.unavailable.length === state.unavailable.length &&
    next.unavailable.every((folderPath, index) => folderPath === state.unavailable[index])
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

/** The state one frame describes. A frame older than the watermark is stale */
export function applyLibraryFrame(frame: LibraryEvent): void {
  if (frame.revision < state.revision) {
    return;
  }
  setState({
    revision: frame.revision,
    folders: [...frame.folders],
    unavailable: [...frame.unavailable],
    streamOpen: state.streamOpen,
  });
  for (const listener of frameListeners) {
    listener(frame);
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

export function setLibraryStreamOpen(open: boolean): void {
  setState({ ...state, streamOpen: open });
}

/** Tests, and a page that wants to start from a clean slate */
export function resetLibraryState(): void {
  state = EMPTY_STATE;
  emit();
}
