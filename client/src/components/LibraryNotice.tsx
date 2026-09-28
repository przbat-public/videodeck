import type { JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { useCacheRefresh } from '../hooks/useCacheRefresh';
import { useLibraryArrivals } from '../hooks/useLibrary';
import { useElasticsearchState } from '../utils/elasticsearchStatus';
import { clearLibraryArrivals } from '../utils/libraryStatus';
import { Button } from './ui/Button';
import { Tooltip } from './ui/Tooltip';

/**
 * "A drive arrived" notice. The library store says which folders arrived, and
 * this is the one place that turns that into an offer, because nothing indexes
 * a drive on its own: the operator decides when the disk work starts.
 *
 * The action is the existing reindex with `onlyMissing`, so a channel whose
 * index survived an earlier session is skipped and keeps serving searches. The
 * notice stands down once the action is taken or dismissed, and the reindex
 * toasts carry the progress from there. What a screen reader hears comes from
 * `LibraryAnnouncer`, whose live region is mounted before this strip exists.
 */
export function LibraryNotice(): JSX.Element | null {
  const { t } = useTranslation();
  const elasticsearch = useElasticsearchState();
  const { loading, refreshCache } = useCacheRefresh();
  const arrived = useLibraryArrivals();

  if (arrived.length === 0) {
    return null;
  }

  // Why the action cannot run right now. A down cluster is a fact about the
  // stack, a run already starting is a fact about this notice.
  const disabledReason =
    elasticsearch === 'down' ? t('library.reindexOffline') : loading ? t('reindex.refreshing') : undefined;

  const startIndexing = (): void => {
    clearLibraryArrivals();
    void refreshCache({ onlyMissing: true });
  };

  return (
    <div className="library-notice">
      <span className="library-notice-text">{t('library.detected', { count: arrived.length })}</span>
      <div className="library-notice-actions">
        <Tooltip label={disabledReason}>
          {/* The span is the Radix tooltip trigger around a disabled button:
              focus is the keyboard path to the reason, and `-1` keeps the
              wrapper out of the tab order while the button itself works. */}
          <span className="library-notice-action" tabIndex={disabledReason === undefined ? -1 : 0}>
            <Button size="small" variant="primary" disabled={disabledReason !== undefined} onClick={startIndexing}>
              {t('library.reindexNew')}
            </Button>
          </span>
        </Tooltip>
        <Button size="small" onClick={clearLibraryArrivals}>
          {t('library.dismiss')}
        </Button>
      </div>
    </div>
  );
}
