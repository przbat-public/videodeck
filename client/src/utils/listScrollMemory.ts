/**
 * Where a reader was in a paged result list, remembered under the search URL
 * that was showing.
 *
 * The list page keeps its state in the URL (phrase, sort, filters) but not how
 * far the reader had scrolled nor how many pages they had pulled in. Without
 * this, opening a video and going back re-runs the first search only: the
 * document is short again, the browser clamps any scroll restoration to the
 * top, and a long session is lost. The page writes a position when it goes
 * away and reads it when the same URL comes back (hooks/useListScrollRestoration).
 *
 * The memory lives for the browsing session only, on purpose: a page count
 * from an older session would spend a stack of requests re-fetching pages the
 * reader never asked for in this one.
 */

export interface ListPosition {
  /** How many videos were on screen (the page size is fixed, so this is also the page count) */
  loadedCount: number;
  /** The window scroll offset in pixels */
  scrollY: number;
}

const positions = new Map<string, ListPosition>();

/** The remembered position for a search URL, if the reader has been there */
export function readListPosition(key: string): ListPosition | undefined {
  return positions.get(key);
}

/** Remember where the reader was; the latest visit to a URL wins */
export function writeListPosition(key: string, position: ListPosition): void {
  positions.set(key, position);
}

/** Drop every remembered position (tests start from a clean session) */
export function clearListPositions(): void {
  positions.clear();
}
