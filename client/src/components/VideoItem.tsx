import type { ChannelVideo, JobType, QueueJob } from '@shared/api';
import type { TFunction } from 'i18next';
import type { JSX } from 'react';
import { memo, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

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

/** Human-readable job status shown next to the row */
function describeJob(job: QueueJob, t: TFunction): string {
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
}

/**
 * The append-only log has no line ids and lines can repeat verbatim, so the
 * key is the content plus its occurrence count — stable while the tail only
 * grows, and unique among siblings.
 */
const keyedLines = (lines: string[]): Array<{ line: string; key: string }> => {
  const occurrences = new Map<string, number>();
  return lines.map((line) => {
    const occurrence = occurrences.get(line) ?? 0;
    occurrences.set(line, occurrence + 1);
    return { line, key: occurrence === 0 ? line : `${line}-${occurrence}` };
  });
};

/** Pins the log to the bottom while a job is running and lines arrive */
function scrollLogToBottom(output: HTMLDivElement | null, isRunning: boolean, jobLog: string[] | undefined): void {
  if (isRunning && jobLog && output) {
    output.scrollTop = output.scrollHeight;
  }
}

interface VideoTitleProps {
  video: ChannelVideoRow;
  isDownloaded: boolean;
  titleWithDate: string;
}

/** Downloaded rows link to the detail page, the rest to YouTube or plain text */
function VideoTitle({ video, isDownloaded, titleWithDate }: VideoTitleProps): JSX.Element {
  if (isDownloaded && video.id) {
    return (
      <Link to={`/video/${encodeURIComponent(video.id)}`} className="video-title-link">
        {titleWithDate}
      </Link>
    );
  }
  if (video.url) {
    return (
      <a href={video.url} target="_blank" rel="noopener noreferrer" className="video-title-link">
        {titleWithDate}
      </a>
    );
  }
  return <span className="video-title">{titleWithDate}</span>;
}

interface VideoItemActionsProps {
  video: ChannelVideoRow;
  job?: QueueJob | undefined;
  isActive: boolean;
  isDownloaded: boolean;
  actionType: JobType;
  onEnqueue: (video: ChannelVideoRow, type: JobType) => void;
  onCancel: (jobId: string) => void;
}

/** Job status badge plus the enqueue/cancel button */
function VideoItemActions({
  video,
  job,
  isActive,
  isDownloaded,
  actionType,
  onEnqueue,
  onCancel,
}: VideoItemActionsProps): JSX.Element {
  const { t } = useTranslation();
  const actionLabel = isDownloaded ? t('app.update') : t('app.download');
  return (
    <div className="video-item-actions">
      {job && (
        <span className={`job-status job-status--${job.status}`} title={job.error}>
          {describeJob(job, t)}
        </span>
      )}
      {isActive ? (
        <button className="cancel-job-button" onClick={() => job && onCancel(job.id)} type="button">
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
  );
}

export function VideoItemInner({ video, isDownloaded, job, onEnqueue, onCancel }: VideoItemProps): JSX.Element {
  const { t, i18n } = useTranslation();
  const outputRef = useRef<HTMLDivElement>(null);

  const isActive = job?.status === 'queued' || job?.status === 'running';
  const isRunning = job?.status === 'running';
  const jobLog = job?.log;

  // Keep the log scrolled to the bottom while new lines arrive
  useEffect(() => {
    scrollLogToBottom(outputRef.current, isRunning, jobLog);
  }, [jobLog, isRunning]);

  const videoTitle = video.title || t('video.noTitle');
  const lastUpdatedFormatted = formatLastUpdated(video.lastUpdated, i18n.language);
  const titleWithDate = lastUpdatedFormatted
    ? t('video.updatedTitle', { title: videoTitle, date: lastUpdatedFormatted })
    : videoTitle;

  const actionType: JobType = isDownloaded ? 'update' : 'download';
  const showLog = job && (isRunning || job.status === 'error') && job.log.length > 0;

  return (
    <div className={`video-item${isActive ? ' video-item--active' : ''}`}>
      <div className="video-item-header">
        <VideoTitle video={video} isDownloaded={isDownloaded} titleWithDate={titleWithDate} />
        <VideoItemActions
          video={video}
          job={job}
          isActive={isActive}
          isDownloaded={isDownloaded}
          actionType={actionType}
          onEnqueue={onEnqueue}
          onCancel={onCancel}
        />
      </div>
      {showLog && (
        <div className="download-output">
          {job.status === 'error' && (
            <div className="download-error">
              <p>{t('app.error', { message: job.error || t('errors.unknown') })}</p>
            </div>
          )}
          <div className="download-output-content" ref={outputRef}>
            {keyedLines(job.log).map(({ line, key }) => (
              <div key={key} className="output-line">
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
