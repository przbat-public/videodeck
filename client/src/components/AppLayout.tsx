import { Clapperboard } from 'lucide-react';
import type { JSX, ReactNode } from 'react';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { useTheme } from '../hooks/useTheme';
import { AppMenu } from './AppMenu';
import type { AppMenuSectionSpec } from './appMenuRegistry';
import { RegisterSectionsContext, SectionsContext, sectionsSignature } from './appMenuRegistry';
import { ElasticsearchBanner } from './ElasticsearchBanner';

/**
 * Holds the section registry and provides it to the top bar and the pages.
 * Local to this file: the provider is an implementation detail of the shell.
 */
function AppMenuProvider({ children }: { children: ReactNode }): JSX.Element {
  const [sections, setSections] = useState<AppMenuSectionSpec[]>([]);
  const register = useCallback((next: AppMenuSectionSpec[]) => {
    setSections((prev) =>
      JSON.stringify(sectionsSignature(prev)) === JSON.stringify(sectionsSignature(next)) ? prev : next,
    );
  }, []);
  return (
    <RegisterSectionsContext value={register}>
      <SectionsContext value={sections}>{children}</SectionsContext>
    </RegisterSectionsContext>
  );
}

/**
 * The shell every page renders inside: the top bar (brand and back link on
 * the left, the gear menu on the right) above the routed page. The bar sits
 * in the page flow, never on top of content.
 */
export function AppLayout(): JSX.Element {
  const { theme, setTheme } = useTheme();
  const { pathname } = useLocation();
  const { t } = useTranslation();
  const onDetailPage = pathname.startsWith('/video/');

  return (
    <AppMenuProvider>
      <header className="app-topbar">
        <div className="topbar-left">
          <Link to="/" className="app-brand" aria-label={t('nav.home')}>
            <Clapperboard aria-hidden="true" focusable="false" className="app-brand-icon" />
          </Link>
          {onDetailPage && (
            <Link to="/" className="app-back">
              ← {t('nav.backToList')}
            </Link>
          )}
        </div>
        <AppMenu theme={theme} onThemeChange={setTheme} />
      </header>
      <ElasticsearchBanner />
      <Outlet />
    </AppMenuProvider>
  );
}
