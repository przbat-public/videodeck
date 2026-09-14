import { memo, useEffect, useRef } from 'react';
import type { JSX } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { ChannelVideo, JobType, QueueJob } from '@shared/api';

/** A list.json entry plus the local "last updated" date from the folder index */
export interface ChannelVideoRow extends ChannelVideo {
  lastUpdated?: string | undefined;
}

export interface VideoItemProps {
  video: ChannelVideoRow;
  isDownloaded: boolean;
  /** Current queue job for this video (if any) */
  job?: QueueJob | undefined;
  onEnqueue: (video: ChannelVideoRow, type: JobType) => void;
  onCancel: (jobId: string) => void;
  scrollContainerRef?: React.RefObject<HTMLDivElement>;
}

/** Date of the last local update, formatted in the current UI language */
const formatLastUpdated = (dateString: string | undefined, locale: string): string => {
  if (!dateString) return '';
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
};

export function VideoItemInner({
  video,
  isDownloaded,
  job,
  onEnqueue,
  onCancel,
  scrollContainerRef,
}: VideoItemProps): JSX.Element {
  const { t, i18n } = useTranslation();
  const itemRef = useRef<HTMLDivElement>(null);
  const outputRef = useRef<HTMLDivElement>(null);

  const isActive = job?.status === 'queued' || job?.status === 'running';
  const isRunning = job?.status === 'running';

  // Bring the item into view when its job starts running
  useEffect(() => {
    if (!isRunning || !itemRef.current) {
      return;
    }
    const item = itemRef.current;
    const container = scrollContainerRef?.current;
    if (container && typeof container.scrollTo === 'function') {
      const containerRect = container.getBoundingClientRect();
      const itemRect = item.getBoundingClientRect();
      container.scrollTo({
        top: container.scrollTop + (itemRect.top - containerRect.top),
        behavior: 'smooth',
      });
    } else if (typeof item.scrollIntoView === 'function') {
      item.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [isRunning, scrollContainerRef]);

  // Keep the log scrolled to the bottom
  useEffect(() => {
    if (isRunning && outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [job?.log, isRunning]);

  const describeJob = (job: QueueJob): string => {
    const verb = job.type === 'update' ? t('queue.verbUpdate') : t('queue.verbDownload');
    switch (job.status) {
      case 'queued':
        return t('queue.statusQueued', { verb });
      case 'running':
        return job.progress !== undefined && job.type === 'download'
          ? t('queue.statusRunningProgress', { verb, progress: Math.round(job.progress) })
          : t('queue.statusRunning', { verb });
      case 'done':
        return job.type === 'update' ? t('queue.statusUpdated') : t('queue.statusDownloaded');
      case 'error':
        return t('queue.statusError');
      case 'cancelled':
        return t('queue.statusCancelled');
      default:
        return '';
    }
  };

  const videoTitle = video.title || t('video.noTitle');
  const lastUpdatedFormatted = formatLastUpdated(video.lastUpdated, i18n.language);
  const titleWithDate = lastUpdatedFormatted
    ? t('video.updatedTitle', { title: videoTitle, date: lastUpdatedFormatted })
    : videoTitle;

  const actionType: JobType = isDownloaded ? 'update' : 'download';
  const actionLabel = isDownloaded ? t('app.update') : t('app.download');
  const showLog = job && (isRunning || job.status === 'error') && job.log.length > 0;

  return (
    <div className={`video-item${isActive ? ' video-item--active' : ''}`} ref={itemRef}>
      <div className="video-item-header">
        {isDownloaded && video.id ? (
          <Link to={`/video/${encodeURIComponent(video.id)}`} className="video-title-link">
            {titleWithDate}
          </Link>
        ) : video.url ? (
          <a
            href={video.url}
            target="_blank"
            rel="noopener noreferrer"
            className="video-title-link"
          >
            {titleWithDate}
          </a>
        ) : (
          <span className="video-title">{titleWithDate}</span>
        )}
        <div className="video-item-actions">
          {job && (
            <span className={`job-status job-status--${job.status}`} title={job.error}>
              {describeJob(job)}
            </span>
          )}
          {isActive ? (
            <button
              className="cancel-job-button"
              onClick={() => job && onCancel(job.id)}
              type="button"
            >
              {t('app.cancel')}
            </button>
          ) : (
            <button
              className={isDownloaded ? 'update-video-button' : 'download-video-button'}
              onClick={() => onEnqueue(video, actionType)}
              disabled={!video.url}
              title={video.url ? undefined : t('video.noUrl')}
              type="button"
            >
              {actionLabel}
            </button>
          )}
        </div>
      </div>
      {showLog && (
        <div className="download-output">
          {job.status === 'error' && (
            <div className="download-error">
              <p>{t('app.error', { message: job.error || t('errors.unknown') })}</p>
            </div>
          )}
          <div className="download-output-content" ref={outputRef}>
            {/* Log lines are a bounded append-only tail; order never changes,
                so the position is a stable identity. Lines have no id of
                their own and can repeat verbatim. */}
            {job.log.map((line, index) => (
              // eslint-disable-next-line @eslint-react/no-array-index-key
              <div key={index} className="output-line">
                {line}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Memoized: channel lists hold thousands of items and the download queue
 * polls every 1.5 s while anything runs — without memo every poll re-rendered
 * every row. The parent passes stable rows/callbacks (see VideoListSection),
 * so the default shallow comparison skips everything but genuinely changed
 * rows (their own job/log updates still re-render this item).
 *
 * useTranslation subscribes this item to language changes, so a memo'd row
 * still re-renders when the user switches languages.
 */
export const VideoItem = memo(VideoItemInner);
