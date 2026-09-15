// Registers the jest-dom matchers on Vitest's `expect`, types included
import '@testing-library/jest-dom/vitest';
// The real i18n instance with the Polish default — components use it directly
import '../i18n';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';
import { toast } from './toastMock';

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

// Fresh toast history per test, regardless of which file asserts it
beforeEach(() => {
  toast.success.mockClear();
  toast.error.mockClear();
  toast.loading.mockClear();
});

// Cleanup after each test
afterEach(() => {
  cleanup();
});
