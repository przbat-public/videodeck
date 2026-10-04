import type { ChannelVideo, JobType, QueueJob } from '@videodeck/shared/api';
import type { TFunction } from 'i18next';
import type { JSX } from 'react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { keyedByOccurrence } from '../utils/keyedByOccurrence';
import { Button } from './ui/Button';
import { Tooltip } from './ui/Tooltip';
import { VideoStateBadges } from './VideoStateBadges';

/** A list.json entry plus the local "last updated" date from the folder index */
export interface ChannelVideoRow extends ChannelVideo {
  lastUpdated?: string | undefined;
}

/**
 * Machine-readable failure codes the server stores in `job.error`; the
 * client translates them through the i18n catalogs. Anything else is shown
 * verbatim (yt-dlp stderr tails).
 */
const FAILURE_MESSAGE_KEYS = {
  'members-only': 'errors.job.members-only',
  private: 'errors.job.private',
  removed: 'errors.job.removed',
  'no-space': 'errors.job.no-space',
  'geo-restricted': 'errors.job.geo-restricted',
  'bot-wall': 'errors.job.bot-wall',
  'age-gate': 'errors.job.age-gate',
} as const;

/** Localized message for a job error, or null when there is nothing to show */
function failureMessage(error: string | undefined, t: TFunction<'common', undefined>): string | null {
  if (error === undefined || error.length === 0) {
    return null;
  }
  // The keys exist in both catalogs (locales.test.ts enforces parity).
  const key = FAILURE_MESSAGE_KEYS[error as keyof typeof FAILURE_MESSAGE_KEYS];
  if (key !== undefined) {
    return t(key);
  }
  return t('app.error', { message: error });
}

export interface VideoItemProps {
  video: ChannelVideoRow;
  isDownloaded: boolean;
  /** Current queue job for this video (if any) */
  job?: QueueJob | undefined;
  onEnqueue: (video: ChannelVideoRow, type: JobType) => void;
  onCancel: (jobId: string) => void;
  /** The row's file-state panel is open underneath it */
  detailsOpen?: boolean;
  /** Opens or closes that panel; a row without it shows no toggle */
  onToggleDetails?: (video: ChannelVideoRow) => void;
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

/** The verb of a running job: a repair is neither a download nor an update */
const VERB_KEYS = {
  download: 'queue.verbDownload',
  update: 'queue.verbUpdate',
  repair: 'queue.verbRepair',
} as const;

/** What a finished job did, which differs per type */
const DONE_KEYS = {
  download: 'queue.statusDownloaded',
  update: 'queue.statusUpdated',
  repair: 'queue.statusRepaired',
} as const;

/** Human-readable job status shown next to the row */
function describeJob(job: QueueJob, t: TFunction): string {
  const verb = t(VERB_KEYS[job.type]);
  switch (job.status) {
    case 'queued':
      return t('queue.statusQueued', { verb });
    case 'running':
      return job.progress !== undefined && job.type === 'download'
        ? t('queue.statusRunningProgress', { verb, progress: Math.round(job.progress) })
        : t('queue.statusRunning', { verb });
    case 'done':
      return t(DONE_KEYS[job.type]);
    case 'error':
      return t('queue.statusError');
    case 'cancelled':
      return t('queue.statusCancelled');
    default:
      return '';
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
  detailsOpen: boolean;
  actionType: JobType;
  onEnqueue: (video: ChannelVideoRow, type: JobType) => void;
  onCancel: (jobId: string) => void;
  onToggleDetails?: ((video: ChannelVideoRow) => void) | undefined;
}

/** Job status badge plus the enqueue/cancel button */
function VideoItemActions({
  video,
  job,
  isActive,
  isDownloaded,
  detailsOpen,
  actionType,
  onEnqueue,
  onCancel,
  onToggleDetails,
}: VideoItemActionsProps): JSX.Element {
  const { t } = useTranslation();
  const actionLabel = isDownloaded ? t('app.update') : t('app.download');
  const actionClassName = isDownloaded ? 'update-video-button' : 'download-video-button';
  const title = video.title || t('video.noTitle');
  return (
    <div className="video-item-actions">
      {onToggleDetails && (
        // The visible label is the same on every row, so the accessible name
        // carries the title: a screen reader hears which row it opens.
        <Button
          size="small"
          onClick={() => onToggleDetails(video)}
          aria-expanded={detailsOpen}
          aria-label={
            detailsOpen ? t('videoState.details.hideLabel', { title }) : t('videoState.details.showLabel', { title })
          }
        >
          {detailsOpen ? t('videoState.details.hide') : t('videoState.details.show')}
        </Button>
      )}
      {job && (
        <Tooltip label={job.error}>
          <span className={`job-status job-status--${job.status}`} tabIndex={job.error ? 0 : undefined}>
            {describeJob(job, t)}
          </span>
        </Tooltip>
      )}
      {isActive ? (
        <button className="cancel-job-button" onClick={() => job && onCancel(job.id)} type="button">
          {t('app.cancel')}
        </button>
      ) : video.url ? (
        <button className={actionClassName} onClick={() => onEnqueue(video, actionType)} type="button">
          {actionLabel}
        </button>
      ) : (
        <Tooltip label={t('video.noUrl')}>
          {/* biome-ignore lint/a11y/noNoninteractiveTabindex: the span is the Radix tooltip trigger around the disabled button; focus is the keyboard path to the hint */}
          <span className="video-item-tooltip-anchor" tabIndex={0}>
            <button className={actionClassName} disabled type="button" style={{ pointerEvents: 'none' }}>
              {actionLabel}
            </button>
          </span>
        </Tooltip>
      )}
    </div>
  );
}

export function VideoItemInner({
  video,
  isDownloaded,
  job,
  onEnqueue,
  onCancel,
  detailsOpen = false,
  onToggleDetails,
}: VideoItemProps): JSX.Element {
  const { t, i18n } = useTranslation();

  const isActive = job?.status === 'queued' || job?.status === 'running';
  const isRunning = job?.status === 'running';
  const progress = Math.min(100, Math.max(0, job?.progress ?? 0));
  // The server drops routine progress lines before they reach the log; an
  // error keeps the meaningful lines (Destination, ERROR, ...) visible.
  const errorLog = job?.status === 'error' ? job.log : [];
  const showLog = errorLog.length > 0;

  const videoTitle = video.title || t('video.noTitle');
  const lastUpdatedFormatted = formatLastUpdated(video.lastUpdated, i18n.language);
  const titleWithDate = lastUpdatedFormatted
    ? t('video.updatedTitle', { title: videoTitle, date: lastUpdatedFormatted })
    : videoTitle;

  const actionType: JobType = isDownloaded ? 'update' : 'download';

  return (
    <div className={`video-item${isActive ? ' video-item--active' : ''}`}>
      <div className="video-item-header">
        <VideoTitle video={video} isDownloaded={isDownloaded} titleWithDate={titleWithDate} />
        <VideoItemActions
          video={video}
          job={job}
          isActive={isActive}
          isDownloaded={isDownloaded}
          detailsOpen={detailsOpen}
          actionType={actionType}
          onEnqueue={onEnqueue}
          onCancel={onCancel}
          onToggleDetails={onToggleDetails}
        />
      </div>
      {/* What the folder state says is on disk for this video; nothing at all
          while /api/folder/state has not answered yet. The catalog's
          availability rides along: it is what tells a members-only video apart
          from one that is merely not downloaded. */}
      <VideoStateBadges state={video.downloadState} availability={video.availability} />
      {isRunning && (
        <div
          className="download-progress"
          role="progressbar"
          aria-label={t('queue.progressLabel', { title: videoTitle })}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress)}
        >
          <div className="download-progress-fill" style={{ width: `${progress}%` }} />
        </div>
      )}
      {showLog && (
        <div className="download-output">
          <div className="download-error">
            <p>{failureMessage(job?.error, t)}</p>
          </div>
          <div className="download-output-content">
            {keyedByOccurrence(errorLog).map(({ value: line, key }) => (
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
