import type { JSX } from 'react';
import { useTranslation } from 'react-i18next';

interface VideoListHeaderProps {
  videosCount: number;
  notDownloadedCount: number;
  downloadedCount: number;
  notUpdatedCount: number;
  runningCount: number;
  queuedCount: number;
  hasActive: boolean;
}

/**
 * What the reader needs to judge a channel's list before touching it: how many
 * videos it holds, how many are missing or old, and what the queue is doing
 * with them. It carries no buttons: every bulk action already lives in the
 * row's ⋯ menu, so a second copy here only asked the reader which one to use.
 */
export function VideoListHeader({
  videosCount,
  notDownloadedCount,
  downloadedCount,
  notUpdatedCount,
  runningCount,
  queuedCount,
  hasActive,
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
    </div>
  );
}
