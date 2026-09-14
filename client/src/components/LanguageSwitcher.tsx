import type { JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { SUPPORTED_LANGUAGES } from '../i18n';

/**
 * PL/EN toggle. The choice goes through i18next (persisted to localStorage),
 * so the whole app re-renders in the picked language.
 */
export function LanguageSwitcher(): JSX.Element {
  const { t, i18n } = useTranslation();

  return (
    <div className="language-switcher" role="group" aria-label={t('app.language')}>
      {SUPPORTED_LANGUAGES.map((lang) => (
        <button
          key={lang}
          type="button"
          className={`language-switcher-option${i18n.resolvedLanguage === lang ? ' active' : ''}`}
          aria-pressed={i18n.resolvedLanguage === lang}
          onClick={() => void i18n.changeLanguage(lang)}
        >
          {lang.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
