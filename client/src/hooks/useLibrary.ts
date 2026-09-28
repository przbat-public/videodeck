import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  getLibraryArrivals,
  getLibraryRevision,
  subscribeLibraryArrivals,
  subscribeLibraryState,
} from '../utils/libraryStatus';

/**
 * The reactive reads of the library store. The revision is what the data hooks
 * depend on: a page re-reads what it renders when the number moves, and it
 * never polls to find out that nothing did. The arrival list is what the
 * notice and its announcement render.
 */
export function useLibraryRevision(): number {
  return useSyncExternalStore(subscribeLibraryState, getLibraryRevision, getLibraryRevision);
}

export function useLibraryArrivals(): string[] {
  return useSyncExternalStore(subscribeLibraryArrivals, getLibraryArrivals, getLibraryArrivals);
}

/**
 * How long a page waits for the first library value before it reads anyway.
 * The stream's opening frame or the health poll answer arrives in
 * milliseconds on a healthy server; this bounds the wait when neither does,
 * so a server that is down still shows its error instead of a page that never
 * asks.
 */
export const LIBRARY_FIRST_READ_GRACE_MS = 1500;

/**
 * The key a library-backed read depends on: null while the first value is
 * still unknown, then the revision.
 *
 * Reading at mount and again when the first value lands costs two full passes
 * over the disks (the server builds its answer before it caches it), and the
 * first one is aborted mid-flight anyway. So the read waits for the baseline
 * it will be compared against, and re-reads on every move after it. Waiting
 * past the grace period is the fallback: a page whose server never answers
 * has to ask before it can report anything.
 */
export function useLibraryReadKey(graceMs: number = LIBRARY_FIRST_READ_GRACE_MS): number | null {
  const revision = useLibraryRevision();
  const [graceElapsed, setGraceElapsed] = useState(false);

  useEffect(() => {
    if (revision > 0 || graceElapsed) {
      return;
    }
    const timer = setTimeout(() => setGraceElapsed(true), graceMs);
    return () => clearTimeout(timer);
  }, [revision, graceElapsed, graceMs]);

  if (revision > 0) {
    return revision;
  }
  return graceElapsed ? 0 : null;
}
