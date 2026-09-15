import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTheme } from './useTheme';

type Listener = (event: { matches: boolean }) => void;

/** A controllable matchMedia stub: flip the OS preference mid-test */
function installMatchMedia(initialDark: boolean) {
  const listeners = new Set<Listener>();
  const media = {
    matches: initialDark,
    addEventListener: vi.fn((_type: string, listener: Listener) => {
      listeners.add(listener);
    }),
    removeEventListener: vi.fn((_type: string, listener: Listener) => {
      listeners.delete(listener);
    }),
  };
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => media),
  );
  return {
    media,
    setSystemDark(dark: boolean) {
      media.matches = dark;
      for (const listener of listeners) {
        listener({ matches: dark });
      }
    },
  };
}

describe('useTheme', () => {
  beforeEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.theme;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('defaults to system and follows the OS preference live', () => {
    const system = installMatchMedia(true);
    const { result } = renderHook(() => useTheme());

    expect(result.current.theme).toBe('system');
    expect(document.documentElement.dataset.theme).toBe('dark');

    act(() => system.setSystemDark(false));
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('applies an explicit choice immediately and persists it', () => {
    installMatchMedia(false);
    const { result } = renderHook(() => useTheme());

    act(() => result.current.setTheme('dark'));
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem('videodeck-theme')).toBe('dark');

    act(() => result.current.setTheme('light'));
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(localStorage.getItem('videodeck-theme')).toBe('light');
  });

  it('ignores an OS change once an explicit theme is chosen', () => {
    const system = installMatchMedia(false);
    const { result } = renderHook(() => useTheme());

    act(() => result.current.setTheme('light'));
    act(() => system.setSystemDark(true));

    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('restores the persisted choice on the next mount', () => {
    localStorage.setItem('videodeck-theme', 'dark');
    installMatchMedia(false);

    renderHook(() => useTheme());

    expect(document.documentElement.dataset.theme).toBe('dark');
  });
});
