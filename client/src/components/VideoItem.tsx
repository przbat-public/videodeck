import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
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

const formatLastUpdated = (dateString?: string): string => {
  if (!dateString) return '';
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('pl-PL', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
};

const describeJob = (job: QueueJob): string => {
  const verb = job.type === 'update' ? 'Aktualizacja' : 'Pobieranie';
  switch (job.status) {
    case 'queued':
      return `${verb}: w kolejce`;
    case 'running':
      return job.progress !== undefined && job.type === 'download'
        ? `${verb}: ${Math.round(job.progress)}%`
        : `${verb}...`;
    case 'done':
      return job.type === 'update' ? 'Zaktualizowano' : 'Pobrano';
    case 'error':
      return 'Błąd';
    case 'cancelled':
      return 'Anulowano';
    default:
      return '';
  }
};

export function VideoItem({
  video,
  isDownloaded,
  job,
  onEnqueue,
  onCancel,
  scrollContainerRef,
}: VideoItemProps): JSX.Element {
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

  const videoTitle = video.title || 'Brak tytułu';
  const lastUpdatedFormatted = formatLastUpdated(video.lastUpdated);
  const titleWithDate = lastUpdatedFormatted
    ? `${videoTitle} (aktualizacja: ${lastUpdatedFormatted})`
    : videoTitle;

  const actionType: JobType = isDownloaded ? 'update' : 'download';
  const actionLabel = isDownloaded ? 'Aktualizuj' : 'Pobierz';
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
              Anuluj
            </button>
          ) : (
            <button
              className={isDownloaded ? 'update-video-button' : 'download-video-button'}
              onClick={() => onEnqueue(video, actionType)}
              disabled={!video.url}
              title={video.url ? undefined : 'Brak URL filmu'}
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
              <p>Błąd: {job.error || 'nieznany błąd'}</p>
            </div>
          )}
          <div className="download-output-content" ref={outputRef}>
            {job.log.map((line, index) => (
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

VideoItem.displayName = 'VideoItem';
