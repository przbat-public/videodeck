import { useCallback, useEffect, useState } from 'react';

export type ThemeChoice = 'system' | 'light' | 'dark';

/**
 * The persisted choice. The inline pre-paint script in client/index.html reads
 * the same key before the first paint, and useTheme.test.ts asserts that the
 * two never drift apart.
 */
export const THEME_STORAGE_KEY = 'videodeck-theme';

/** The user's persisted choice, or 'system' */
function readStoredTheme(): ThemeChoice {
  const value = localStorage.getItem(THEME_STORAGE_KEY);
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'system';
}

/** What the OS prefers (dark: true/false) */
function systemPrefersDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function resolveTheme(choice: ThemeChoice): 'light' | 'dark' {
  return choice === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : choice;
}

/**
 * App theme (light/dark/system). The resolved value is written to
 * `document.documentElement[data-theme]`, where the CSS tokens switch; the
 * choice persists in localStorage under THEME_STORAGE_KEY. index.html reads
 * that key inline before the first paint, so the first frame is already
 * themed; from mount on this hook owns the choice, including an OS preference
 * change while the choice is 'system' (the CSS resolves light-dark() on its
 * own, but the attribute has to name the painted theme).
 */
export function useTheme(): { theme: ThemeChoice; setTheme: (theme: ThemeChoice) => void } {
  const [themeChoice, setThemeChoice] = useState<ThemeChoice>(readStoredTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = resolveTheme(themeChoice);

    if (themeChoice !== 'system') {
      return;
    }
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      document.documentElement.dataset.theme = resolveTheme('system');
    };
    media.addEventListener('change', onChange);
    return () => {
      media.removeEventListener('change', onChange);
    };
  }, [themeChoice]);

  const setTheme = useCallback((next: ThemeChoice) => {
    localStorage.setItem(THEME_STORAGE_KEY, next);
    setThemeChoice(next);
  }, []);

  return { theme: themeChoice, setTheme };
}
