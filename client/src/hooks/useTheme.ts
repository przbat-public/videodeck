import { useCallback, useEffect, useState } from 'react';

export type ThemeChoice = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'videodeck-theme';

/** The user's persisted choice, or 'system' */
function readStoredTheme(): ThemeChoice {
  const value = localStorage.getItem(STORAGE_KEY);
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
 * choice persists in localStorage. While the choice is 'system', an OS
 * preference change re-resolves it live.
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
    localStorage.setItem(STORAGE_KEY, next);
    setThemeChoice(next);
  }, []);

  return { theme: themeChoice, setTheme };
}
