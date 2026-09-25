import { useEffect, useRef } from 'react';
import type { ListPosition } from '../utils/listScrollMemory';
import { readListPosition, writeListPosition } from '../utils/listScrollMemory';

export interface ListScrollRestorationOptions {
  /** The search URL the list is showing; a position is remembered per URL */
  key: string;
  /** How many videos are on screen right now */
  loadedCount: number;
  /** The server knows about more videos than are loaded */
  hasMore: boolean;
  /** A request is in flight; the hook waits for it to settle before it acts */
  busy: boolean;
  /** Fetches the next page and appends it; what it resolves with is not its concern */
  loadMore: () => Promise<unknown>;
}

/**
 * Brings a reader back to where they were in a paged result list.
 *
 * Going into a video and back re-mounts the list, which starts over with page
 * one: the document is short again, so any scroll offset is clamped to the
 * top, and a long reading session is lost. This hook hangs on to the offset
 * and to how much was loaded (utils/listScrollMemory, keyed by the search
 * URL), then puts both back: it re-fetches the pages that were on screen, and
 * only once they are back does it scroll, because scrolling into a document
 * that has not been re-rendered yet lands at the top.
 *
 * Restoration happens once per visit: after that the reader owns the scroll
 * position. Two guards keep it cheap and honest: it waits for the first page
 * of the search before it decides anything, and it asks for one page more at
 * most per loaded count, so a server that keeps reporting more results than
 * it returns cannot turn the restore into a request loop.
 */
export function useListScrollRestoration({
  key,
  loadedCount,
  hasMore,
  busy,
  loadMore,
}: ListScrollRestorationOptions): void {
  // The key whose stored position has been read; a restored (or absent)
  // position must not be read again on the next render, or the reader could
  // never scroll away from it.
  const handledKeyRef = useRef<string | null>(null);
  // The position to come back to for the key being rendered. Read during
  // render, once per key: the store is written by the unmount of the previous
  // page, so by the time this page renders the value is already correct.
  const pendingRef = useRef<{ key: string; target: ListPosition } | null>(null);
  // The loaded count a page was last requested at, to detect pages that add nothing
  const requestedAtRef = useRef(-1);
  // The newest committed count and the reader's own offset, for the cleanup
  // that runs long after the render
  const latestCountRef = useRef(loadedCount);
  const latestScrollYRef = useRef(0);

  if (handledKeyRef.current !== key) {
    handledKeyRef.current = key;
    const target = readListPosition(key);
    pendingRef.current = target === undefined || target.loadedCount <= 0 ? null : { key, target };
    requestedAtRef.current = -1;
  }

  useEffect(() => {
    latestCountRef.current = loadedCount;
  }, [loadedCount]);

  // Follow the reader's scrolling. Reading window.scrollY when the list is
  // torn down is too late: the incoming page replaces it in the same commit,
  // the document gets shorter and the browser clamps the offset first, so the
  // remembered place would be the clamp instead of where the reader was.
  useEffect(() => {
    const trackScroll = (): void => {
      latestScrollYRef.current = window.scrollY;
    };
    window.addEventListener('scroll', trackScroll, { passive: true });
    return () => window.removeEventListener('scroll', trackScroll);
  }, []);

  useEffect(() => {
    const pending = pendingRef.current;
    if (pending === null || loadedCount === 0 || busy) {
      return;
    }
    const caughtUp = loadedCount >= pending.target.loadedCount;
    const pageAddedNothing = requestedAtRef.current === loadedCount;
    if (caughtUp || !hasMore || pageAddedNothing) {
      pendingRef.current = null;
      window.scrollTo(0, pending.target.scrollY);
      return;
    }
    requestedAtRef.current = loadedCount;
    void loadMore();
  }, [busy, hasMore, loadedCount, loadMore]);

  // Remember the place for the next visit, under the URL that was showing.
  // The cleanup covers both ways of leaving: a route change unmounts the page,
  // and a new search changes the key while the old results are still up.
  useEffect(() => {
    return () => {
      const count = latestCountRef.current;
      if (count === 0) {
        return; // nothing was on screen, so there is no place to come back to
      }
      // The live offset still counts when it is the larger one: the reader may
      // have scrolled since the last event, and a lagging sample only ever
      // reads low.
      const scrollY = Math.max(latestScrollYRef.current, window.scrollY);
      writeListPosition(key, { loadedCount: count, scrollY });
    };
  }, [key]);
}
