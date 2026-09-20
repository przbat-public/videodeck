import type { JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { useServerHealth } from '../hooks/useServerHealth';
import { Button } from './ui/Button';

/**
 * One banner for a stack whose search backend is gone. It sits in the shell, so
 * every page says the same thing instead of each turning a dependency failure
 * into its own "something went wrong". The retry asks `/health` right away, and
 * the banner clears itself as soon as Elasticsearch answers again.
 *
 * This is the only component that polls: the pages and the menu read the same
 * state from the store.
 */
export function ElasticsearchBanner(): JSX.Element | null {
  const { t } = useTranslation();
  const { elasticsearch, recheck } = useServerHealth();

  if (elasticsearch !== 'down') {
    return null;
  }

  return (
    <div className="health-banner" role="status">
      <span className="health-banner-text">{t('health.elasticsearchDown')}</span>
      <Button size="small" onClick={() => void recheck()}>
        {t('health.recheck')}
      </Button>
    </div>
  );
}
