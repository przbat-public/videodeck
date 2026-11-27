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
 * A cluster that answers but refuses writes, as it does on a nearly full disk,
 * gets the same strip with its own message: search works, and new videos do
 * not reach it. The write after a download gives up after about 10.5 minutes
 * of retries, so the message names the way back in the menu's own labels: a
 * reindex with the only-missing switch off, once writes come back. An outage
 * outranks that message, since nothing works then.
 *
 * This is the only component that polls: the pages and the menu read the same
 * state from the store.
 */
export function ElasticsearchBanner(): JSX.Element | null {
  const { t } = useTranslation();
  const { elasticsearch, writesRefused, recheck } = useServerHealth();

  let message: string;
  if (elasticsearch === 'down') {
    message = t('health.elasticsearchDown');
  } else if (writesRefused) {
    message = t('health.elasticsearchReadOnly', {
      refresh: t('reindex.start'),
      onlyMissing: t('reindex.onlyMissing'),
    });
  } else {
    return null;
  }

  return (
    <div className="health-banner" role="status">
      <span className="health-banner-text">{message}</span>
      <Button size="small" onClick={() => void recheck()}>
        {t('health.recheck')}
      </Button>
    </div>
  );
}
