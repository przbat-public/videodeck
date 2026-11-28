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
 * The strip renders inside a `role="status"` region that stays mounted while
 * the stack is healthy. A live region created together with its text is not
 * announced, which is why `LibraryAnnouncer` stays mounted too; here the
 * region holds the strip itself, so the text is in the tree once, and a
 * message that appears where there was none is read out.
 *
 * This is the only component that polls: the pages and the menu read the same
 * state from the store.
 */
export function ElasticsearchBanner(): JSX.Element {
  const { t } = useTranslation();
  const { elasticsearch, writesRefused, recheck } = useServerHealth();

  let message: string | null = null;
  if (elasticsearch === 'down') {
    message = t('health.elasticsearchDown');
  } else if (writesRefused) {
    message = t('health.elasticsearchReadOnly', {
      refresh: t('reindex.start'),
      onlyMissing: t('reindex.onlyMissing'),
    });
  }

  return (
    // Empty and without a box of its own while there is nothing to say: the
    // visible strip exists only while a message applies
    <div role="status" aria-live="polite">
      {message !== null && (
        <div className="health-banner">
          <span className="health-banner-text">{message}</span>
          <Button size="small" onClick={() => void recheck()}>
            {t('health.recheck')}
          </Button>
        </div>
      )}
    </div>
  );
}
