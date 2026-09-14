// Registers the jest-dom matchers on Vitest's `expect`, types included
import '@testing-library/jest-dom/vitest';
// The real i18n instance with the Polish default — components use it directly
import '../i18n';
import { afterEach, beforeEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { toast } from './toastMock';

// Every component that touches react-hot-toast gets the same mock instance
// (see test/toastMock.ts); this replaces the six per-file copies.
vi.mock('react-hot-toast', async () => {
  const { toast: sharedToast } = await import('./toastMock');
  return { default: sharedToast };
});

// jsdom lacks the browser APIs Radix UI primitives (Select) touch. These
// no-op stubs make the real component render/interact in tests.
class ResizeObserverMock {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

globalThis.ResizeObserver ??= ResizeObserverMock as unknown as typeof ResizeObserver;
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};

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
