import type { JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from './ui/Button';

interface VideoListHeaderProps {
  videosCount: number;
  notDownloadedCount: number;
  downloadedCount: number;
  notUpdatedCount: number;
  runningCount: number;
  queuedCount: number;
  hasActive: boolean;
  /** Which bulk action is armed for the confirming second click */
  armedBulk: null | 'download' | 'update' | 'update-old';
  onDownloadAll: () => void;
  onUpdateOld: () => void;
  onUpdateAll: () => void;
  onCancelAll: () => void;
}

/**
 * The header of a channel's video list: counts of missing/stale videos, the
 * queue summary and the bulk-action buttons with their confirm-on-second-
 * click arming. Extracted from VideoListSection (it used to own the list
 * fetching, the queue wiring AND the bulk actions in one component).
 */
export function VideoListHeader({
  videosCount,
  notDownloadedCount,
  downloadedCount,
  notUpdatedCount,
  runningCount,
  queuedCount,
  hasActive,
  armedBulk,
  onDownloadAll,
  onUpdateOld,
  onUpdateAll,
  onCancelAll,
}: VideoListHeaderProps): JSX.Element {
  const { t } = useTranslation();

  return (
    <div className="videos-list-header">
      <p className="videos-count">
        {t('queue.videoListCount', { count: videosCount })}
        {notDownloadedCount > 0 && ` ${t('queue.notDownloaded', { count: notDownloadedCount })}`}
        {notUpdatedCount > 0 && ` ${t('queue.notUpdated', { count: notUpdatedCount })}`}
        {downloadedCount > 0 && notDownloadedCount === 0 && notUpdatedCount === 0 && ` ${t('queue.allDownloaded')}`}
        {hasActive && (
          <>
            {' '}
            <span className="queue-summary">
              {t('queue.inProgress', { running: runningCount, queued: queuedCount })}
            </span>
          </>
        )}
      </p>
      <div className="videos-list-buttons">
        {notDownloadedCount > 0 && (
          <Button variant="primary" onClick={onDownloadAll}>
            {armedBulk === 'download' ? t('queue.confirmMany', { count: notDownloadedCount }) : t('queue.downloadAll')}
          </Button>
        )}
        {notUpdatedCount > 0 && (
          <Button variant="primary" onClick={onUpdateOld}>
            {armedBulk === 'update-old' ? t('queue.confirmMany', { count: notUpdatedCount }) : t('queue.updateOld')}
          </Button>
        )}
        {downloadedCount > 0 && (
          <Button variant="primary" onClick={onUpdateAll}>
            {armedBulk === 'update' ? t('queue.confirmMany', { count: downloadedCount }) : t('queue.updateAll')}
          </Button>
        )}
        {hasActive && (
          <Button variant="danger" onClick={onCancelAll}>
            {t('queue.cancelAll')}
          </Button>
        )}
      </div>
    </div>
  );
}
