import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearListPositions, readListPosition, writeListPosition } from '../utils/listScrollMemory';
import { useListScrollRestoration } from './useListScrollRestoration';

interface Options {
  key: string;
  loadedCount: number;
  hasMore: boolean;
  busy: boolean;
  loadMore: () => Promise<void>;
}

/** jsdom never lays anything out, so the scroll offset is pinned by hand */
function setScrollY(value: number): void {
  Object.defineProperty(window, 'scrollY', { configurable: true, value });
}

const scrollTo = vi.fn();

const renderRestoration = (overrides: Partial<Options> = {}) => {
  const loadMore = vi.fn(async (): Promise<void> => undefined);
  const view = renderHook((props: Options) => useListScrollRestoration(props), {
    initialProps: {
      key: '/',
      loadedCount: 100,
      hasMore: false,
      busy: false,
      loadMore,
      ...overrides,
    },
  });
  return { ...view, loadMore };
};

describe('useListScrollRestoration', () => {
  beforeEach(() => {
    clearListPositions();
    scrollTo.mockClear();
    vi.stubGlobal('scrollTo', scrollTo);
    setScrollY(0);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(window, 'scrollY');
  });

  it('scrolls back to the remembered offset of the same search URL', () => {
    writeListPosition('/?q=drone', { loadedCount: 100, scrollY: 1200 });

    renderRestoration({ key: '/?q=drone' });

    expect(scrollTo).toHaveBeenCalledWith(0, 1200);
  });

  it('reloads the pages that were on screen before it scrolls', () => {
    writeListPosition('/', { loadedCount: 200, scrollY: 1500 });
    const { loadMore, rerender } = renderRestoration({ loadedCount: 100, hasMore: true });

    // Page one is there, page two is not: ask for it and stay put
    expect(loadMore).toHaveBeenCalledTimes(1);
    expect(scrollTo).not.toHaveBeenCalled();

    // The request is in flight: still nothing to do
    rerender({ key: '/', loadedCount: 100, hasMore: true, busy: true, loadMore });
    expect(loadMore).toHaveBeenCalledTimes(1);

    rerender({ key: '/', loadedCount: 200, hasMore: true, busy: false, loadMore });

    expect(scrollTo).toHaveBeenCalledWith(0, 1500);
    expect(loadMore).toHaveBeenCalledTimes(1);
  });

  it('stops asking and restores the offset when the library has shrunk', () => {
    writeListPosition('/', { loadedCount: 500, scrollY: 3000 });

    renderRestoration({ loadedCount: 120, hasMore: false });

    expect(scrollTo).toHaveBeenCalledWith(0, 3000);
  });

  it('asks for one page more, then gives up if that page added nothing', () => {
    writeListPosition('/', { loadedCount: 500, scrollY: 3000 });
    const { loadMore, rerender } = renderRestoration({ loadedCount: 100, hasMore: true });

    expect(loadMore).toHaveBeenCalledTimes(1);

    // The request goes out ...
    rerender({ key: '/', loadedCount: 100, hasMore: true, busy: true, loadMore });
    // ... and comes back empty while the server still claims there is more:
    // asking again would spin forever
    rerender({ key: '/', loadedCount: 100, hasMore: true, busy: false, loadMore });

    expect(loadMore).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith(0, 3000);
  });

  it('waits for the first page of the search before it decides anything', () => {
    writeListPosition('/', { loadedCount: 200, scrollY: 900 });
    const { loadMore, rerender } = renderRestoration({ loadedCount: 0, hasMore: false });

    expect(loadMore).not.toHaveBeenCalled();
    expect(scrollTo).not.toHaveBeenCalled();

    rerender({ key: '/', loadedCount: 100, hasMore: true, busy: false, loadMore });

    expect(loadMore).toHaveBeenCalledTimes(1);
  });

  it('leaves a search URL it has never seen alone', () => {
    writeListPosition('/?q=drone', { loadedCount: 200, scrollY: 1500 });

    const { loadMore } = renderRestoration({ key: '/?q=kosmos', loadedCount: 100, hasMore: true });

    expect(loadMore).not.toHaveBeenCalled();
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('restores a position once, never again over the reader', () => {
    writeListPosition('/', { loadedCount: 100, scrollY: 1200 });
    const { rerender, loadMore } = renderRestoration();

    expect(scrollTo).toHaveBeenCalledTimes(1);

    rerender({ key: '/', loadedCount: 200, hasMore: false, busy: false, loadMore });

    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  it('remembers the pages and the offset when the reader leaves', () => {
    setScrollY(2400);
    const { unmount } = renderRestoration({ key: '/?q=drone', loadedCount: 200 });

    unmount();

    expect(readListPosition('/?q=drone')).toEqual({ loadedCount: 200, scrollY: 2400 });
  });

  it('remembers the place the reader scrolled to, not the clamp of a shorter page', () => {
    const { unmount } = renderRestoration({ key: '/?q=drone', loadedCount: 200 });

    // The reader scrolls deep into the list, so the browser reports it
    setScrollY(2400);
    window.dispatchEvent(new Event('scroll'));
    // The page they open is shorter: removing the list clamps the offset
    // before the cleanup runs, which is what a real browser does
    setScrollY(81);

    unmount();

    expect(readListPosition('/?q=drone')).toEqual({ loadedCount: 200, scrollY: 2400 });
  });

  it('remembers nothing when no result was ever on screen', () => {
    setScrollY(500);
    const { unmount } = renderRestoration({ loadedCount: 0 });

    unmount();

    expect(readListPosition('/')).toBeUndefined();
  });

  it('files the position under the URL the reader was actually reading', () => {
    setScrollY(1800);
    const { rerender, loadMore } = renderRestoration({ key: '/?q=drone', loadedCount: 200 });

    // A new search replaces the URL while the old results are still on screen
    rerender({ key: '/?q=kosmos', loadedCount: 200, hasMore: false, busy: true, loadMore });

    expect(readListPosition('/?q=drone')).toEqual({ loadedCount: 200, scrollY: 1800 });
    expect(readListPosition('/?q=kosmos')).toBeUndefined();
  });
});
