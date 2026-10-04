// Registers the jest-dom matchers on Vitest's `expect`, types included
import '@testing-library/jest-dom/vitest';
// The real i18n instance with the Polish default — components use it directly
import '../i18n';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';
import { applyLibraryRevision, resetLibraryState } from '../utils/libraryStatus';
import { resetReindexState } from '../utils/reindexStore';
import { toast } from './toastMock';

/**
 * The library revision a test starts from. A real page mounts after the
 * shell's first probe has answered, so the store already knows a revision by
 * the time the data hooks read: with it the gated read fires once, at mount,
 * which is the behaviour these tests describe. A test about the "nothing known
 * yet" state resets the store itself.
 */
export const TEST_LIBRARY_REVISION = 1;

// Every component that touches react-hot-toast gets the same mock instance
// (see test/toastMock.ts); this replaces the six per-file copies. The real
// <Toaster /> renders nothing — App-level tests (the integration suite)
// mount the whole tree, and the mock must provide the component too.
vi.mock('react-hot-toast', async () => {
  const { toast: sharedToast } = await import('./toastMock');
  return { default: sharedToast, Toaster: () => null };
});

// jsdom lacks the browser APIs Radix UI primitives (Select) touch. These
// no-op stubs make the real component render/interact in tests.
class ResizeObserverMock {
  observe(): void {
    /* no-op: jsdom has no layout observer */
  }
  unobserve(): void {
    /* no-op */
  }
  disconnect(): void {
    /* no-op */
  }
}

globalThis.ResizeObserver ??= ResizeObserverMock as unknown as typeof ResizeObserver;
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {
  /* no-op */
};
Element.prototype.releasePointerCapture ??= () => {
  /* no-op */
};
Element.prototype.scrollIntoView ??= () => {
  /* no-op: jsdom has no layout to scroll */
};

// jsdom 30 has the <dialog> element but none of its methods, and the modal
// primitive opens itself with showModal(). The stub keeps the element's open
// state and its close event; the top layer, the backdrop, the focus trap and
// Escape-on-a-modal belong to the browser and are covered by the e2e suite.
HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement): void {
  this.open = true;
};
HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement): void {
  this.open = false;
  this.dispatchEvent(new Event('close'));
};

// jsdom has no matchMedia; the theme hook asks about prefers-color-scheme.
// Default to light — tests that care stub their own implementation.
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {
        /* no-op */
      },
      removeEventListener: () => {
        /* no-op */
      },
      addListener: () => {
        /* no-op */
      },
      removeListener: () => {
        /* no-op */
      },
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

// Fresh toast history per test, regardless of which file asserts it. The
// library store is module-level state too (the stream writes it, the data
// hooks read it), so a revision one test moved would otherwise decide whether
// the next test's mount reads once or twice.
beforeEach(() => {
  toast.success.mockClear();
  toast.error.mockClear();
  toast.loading.mockClear();
  resetLibraryState();
  applyLibraryRevision(TEST_LIBRARY_REVISION);
  // The reindex run is app state too: a run left behind by one test would make
  // the next one's button disabled for no reason it can see
  resetReindexState();
});

// Cleanup after each test
afterEach(() => {
  cleanup();
});
