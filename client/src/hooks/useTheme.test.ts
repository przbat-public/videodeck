import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import indexHtml from '../../index.html?raw';
import { THEME_STORAGE_KEY, useTheme } from './useTheme';

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

  it('keeps a stored light choice when the system prefers dark', () => {
    localStorage.setItem('videodeck-theme', 'light');
    installMatchMedia(true);

    renderHook(() => useTheme());

    expect(document.documentElement.dataset.theme).toBe('light');
  });
});

/**
 * The inline script in client/index.html runs while the parser is still inside
 * <head>, before the stylesheet is fetched. That is the point of it: a stored
 * dark choice has to reach <html> before the first paint, otherwise the first
 * frame is light. React and useTheme only take over after mount.
 */
function prePaintScript(): string {
  const script = /<script>([\s\S]*?)<\/script>/.exec(indexHtml)?.[1];
  if (script === undefined || script.trim() === '') {
    throw new Error('client/index.html has no inline pre-paint theme script');
  }
  return script;
}

/**
 * Run those exact bytes the way the parser does. The source is a committed
 * literal, never input, and jsdom supplies the same globals (document,
 * localStorage) the browser would.
 */
function runPrePaintScript(): void {
  new Function(prePaintScript())();
}

describe('the pre-paint theme script in index.html', () => {
  beforeEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.theme;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads exactly the storage key useTheme persists to', () => {
    const keys = [...prePaintScript().matchAll(/localStorage\.getItem\(\s*'([^']+)'\s*\)/g)].map(
      (match) => match[1] ?? '',
    );

    expect(keys).toEqual([THEME_STORAGE_KEY]);
  });

  it('keeps that key stable, so a rename cannot drop saved choices', () => {
    expect(THEME_STORAGE_KEY).toBe('videodeck-theme');
  });

  it('applies a stored dark choice before the first paint', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');

    runPrePaintScript();

    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('applies a stored light choice even when the system prefers dark', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'light');
    installMatchMedia(true);

    runPrePaintScript();

    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('leaves data-theme unset for the system choice, so the OS decides', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'system');

    runPrePaintScript();

    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it('survives a blocked localStorage instead of breaking the page', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('localStorage is blocked');
    });

    expect(runPrePaintScript).not.toThrow();
    expect(document.documentElement.dataset.theme).toBeUndefined();

    getItem.mockRestore();
  });
});
