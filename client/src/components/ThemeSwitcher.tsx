import type { JSX } from 'react';
import { useTranslation } from 'react-i18next';
import type { ThemeChoice } from '../hooks/useTheme';
import { Select } from './ui/Select';

const THEME_CHOICES: { value: ThemeChoice; labelKey: 'theme.system' | 'theme.light' | 'theme.dark' }[] = [
  { value: 'system', labelKey: 'theme.system' },
  { value: 'light', labelKey: 'theme.light' },
  { value: 'dark', labelKey: 'theme.dark' },
];

interface ThemeSwitcherProps {
  theme: ThemeChoice;
  onThemeChange: (theme: ThemeChoice) => void;
}

/**
 * System/light/dark picker. The resolved value lands on
 * `<html data-theme=…>` (see useTheme), where the CSS tokens switch.
 */
export function ThemeSwitcher({ theme, onThemeChange }: ThemeSwitcherProps): JSX.Element {
  const { t } = useTranslation();

  return (
    <Select
      value={theme}
      onChange={(value) => onThemeChange(value as ThemeChoice)}
      className="theme-select"
      aria-label={t('theme.label')}
      items={THEME_CHOICES.map((choice) => ({
        value: choice.value,
        label: t(choice.labelKey),
      }))}
    />
  );
}
