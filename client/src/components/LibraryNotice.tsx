import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useCacheRefresh } from '../hooks/useCacheRefresh';
import { useElasticsearchState } from '../utils/elasticsearchStatus';
import { subscribeLibraryFrames } from '../utils/libraryStatus';
import { Button } from './ui/Button';
import { Tooltip } from './ui/Tooltip';

/**
 * "A drive arrived" notice. The event stream says which folders the library
 * gained, and this is the one place that turns that into an offer, because
 * nothing indexes a drive on its own: the operator decides when the disk work
 * starts.
 *
 * The action is the existing reindex with `onlyMissing`, so a channel whose
 * index survived an earlier session is skipped and keeps serving searches. The
 * notice stands down once the action is taken or dismissed, and the reindex
 * toasts carry the progress from there.
 */
export function LibraryNotice(): JSX.Element | null {
  const { t } = useTranslation();
  const elasticsearch = useElasticsearchState();
  const { loading, refreshCache } = useCacheRefresh();
  const [arrived, setArrived] = useState<string[]>([]);

  useEffect(
    () =>
      subscribeLibraryFrames((frame) => {
        const added = frame.added ?? [];
        if (added.length === 0) {
          return; // the opening frame carries the library, not a change
        }
        setArrived((previous) => [...previous, ...added.filter((folderPath) => !previous.includes(folderPath))]);
      }),
    [],
  );

  if (arrived.length === 0) {
    return null;
  }

  // Why the action cannot run right now. A down cluster is a fact about the
  // stack, a run already starting is a fact about this notice.
  const disabledReason =
    elasticsearch === 'down' ? t('library.reindexOffline') : loading ? t('reindex.refreshing') : undefined;

  const startIndexing = (): void => {
    setArrived([]);
    void refreshCache({ onlyMissing: true });
  };

  return (
    <div className="library-notice" role="status">
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
        <Button size="small" onClick={() => setArrived([])}>
          {t('library.dismiss')}
        </Button>
      </div>
    </div>
  );
}
