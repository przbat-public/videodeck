import type { RefObject } from 'react';
import { useEffect, useRef } from 'react';

/** How far below the viewport the end of the list starts the next page */
const LOAD_AHEAD_MARGIN = '0px 0px 600px 0px';

/**
 * Infinite scroll: calls `onLoadMore` when the element behind the returned
 * ref comes near the bottom of the viewport, as long as `enabled` holds.
 *
 * The observer is rebuilt every time `enabled` turns back on, and a fresh
 * observer reports the current position at once. So a page that leaves the
 * end still in reach asks for the next one without waiting for a scroll.
 * Where IntersectionObserver is missing nothing happens, and the caller's
 * button stays the way to load more.
 */
export function useAutoLoadMore<T extends Element>(onLoadMore: () => void, enabled: boolean): RefObject<T | null> {
  const endRef = useRef<T>(null);

  useEffect(() => {
    const end = endRef.current;
    if (!enabled || end === null || typeof IntersectionObserver === 'undefined') {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          onLoadMore();
        }
      },
      { rootMargin: LOAD_AHEAD_MARGIN },
    );
    observer.observe(end);
    return () => observer.disconnect();
  }, [enabled, onLoadMore]);

  return endRef;
}
