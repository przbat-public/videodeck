import type { ChannelVideo, JobType, QueueJob } from '@videodeck/shared/api';
import { FolderListResponseSchema } from '@videodeck/shared/schemas';
import type { JSX, Ref } from 'react';
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { List, type RowComponentProps, useDynamicRowHeight, useListRef } from 'react-window';
import { useDownloadQueue } from '../hooks/useDownloadQueue';
import { apiGet } from '../utils/apiClient';
import { logError } from '../utils/logError';
import { selectDownloadable, selectDownloaded, selectStale } from '../utils/videoSelection';
import { ErrorMessage } from './ui/ErrorMessage';
import { VideoItem } from './VideoItem';
import { VideoListHeader } from './VideoListHeader';

/**
 * Starting estimate for a row. The real height depends on the title and on
 * whether the row carries a progress bar or an error log, and the old fixed
 * 58/84/220 trio never matched: a long title measured 276–528 px and an error
 * row 398 px, so react-window painted the next row over them. The measured
 * height from useDynamicRowHeight is used instead.
 */
const DEFAULT_ROW_HEIGHT = 58;

/**
 * react-window re-renders and re-measures every row when `rowProps` changes
 * identity, so the empty object has to be shared, not rebuilt per render.
 */
const ROW_PROPS = {};

interface VideoListSectionProps {
  folderPath: string;
  listExists: boolean;
  /** A job was queued or cancelled here; the console re-reads the whole queue */
  onQueueChanged?: () => void;
}

export interface VideoListSectionHandle {
  loadVideos: () => Promise<void>;
}

/**
 * React 19 passes `ref` as a regular prop — no forwardRef wrapper needed.
 */
export function VideoListSection({
  folderPath,
  listExists,
  onQueueChanged,
  ref,
}: VideoListSectionProps & { ref?: Ref<VideoListSectionHandle> }): JSX.Element | null {
  const [videos, setVideos] = useState<ChannelVideo[]>([]);
  const [downloadStatuses, setDownloadStatuses] = useState<Record<string, boolean>>({});
  const [lastUpdatedDates, setLastUpdatedDates] = useState<Record<string, string>>({});
  const { t } = useTranslation();
  const [isLoadingVideos, setIsLoadingVideos] = useState(false);
  const [videosError, setVideosError] = useState<string | null>(null);
  const [hasLoadedVideos, setHasLoadedVideos] = useState(false);
  const listRef = useListRef(null);
  // Measured per-row heights, reset when the folder changes: a job log or a
  // longer title changes the row, and a stale estimate overlapped the next row.
  const rowHeight = useDynamicRowHeight({
    defaultRowHeight: DEFAULT_ROW_HEIGHT,
    key: `${folderPath}:${listExists}`,
  });

  const fetchList = useCallback(async () => {
    const data = await apiGet(
      `/api/folder/list?folderPath=${encodeURIComponent(folderPath)}`,
      FolderListResponseSchema,
      {
        message: 'Failed to load videos',
      },
    );
    setVideos(data.videos);
    setDownloadStatuses(data.downloadStatuses);
    setLastUpdatedDates(data.lastUpdatedDates);
    setHasLoadedVideos(true);
  }, [folderPath]);

  // Visible reload (spinner), used by the parent and on demand
  const loadVideos = useCallback(async () => {
    if (!listExists) {
      return;
    }
    try {
      setIsLoadingVideos(true);
      setVideosError(null);
      await fetchList();
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'An error occurred';
      setVideosError(errorMessage);
      logError(err);
    } finally {
      setIsLoadingVideos(false);
    }
  }, [fetchList, listExists]);

  // When a job finishes, reflect it locally right away; the queue-drained
  // callback re-syncs exact dates from the server.
  const handleJobFinished = useCallback((job: QueueJob) => {
    if (job.status !== 'done') {
      return;
    }
    const finishedAt = job.finishedAt || new Date().toISOString();
    setDownloadStatuses((prev) => ({ ...prev, [job.videoId]: true }));
    setLastUpdatedDates((prev) => ({ ...prev, [job.videoId]: finishedAt }));
  }, []);

  const handleQueueDrained = useCallback(() => {
    fetchList().catch((err) => logError(err));
  }, [fetchList]);

  const handleQueueChanged = useCallback(() => {
    onQueueChanged?.();
  }, [onQueueChanged]);

  // Destructured so the useCallback dependencies below reference the stable
  // members directly instead of the whole (freshly created) queue object
  const {
    jobs,
    activeCount,
    hasActive,
    error: queueError,
    cancelAll,
    enqueue,
    cancel,
    jobsByVideoId,
  } = useDownloadQueue(folderPath, {
    enabled: listExists,
    onJobFinished: handleJobFinished,
    onQueueDrained: handleQueueDrained,
    onQueueChanged: handleQueueChanged,
  });

  // Reset per-folder state when the folder or the existence of list.json
  // changes. Adjusted during render (React docs pattern) instead of in an
  // effect, so no extra render pass and no lint suppression is needed.
  const [resetKey, setResetKey] = useState(`${folderPath}:${listExists}`);
  const currentResetKey = `${folderPath}:${listExists}`;
  if (currentResetKey !== resetKey) {
    setResetKey(currentResetKey);
    setVideos([]);
    setDownloadStatuses({});
    setLastUpdatedDates({});
    setVideosError(null);
    setHasLoadedVideos(false);
  }

  useImperativeHandle(ref, () => ({ loadVideos }), [loadVideos]);

  const enqueueVideos = useCallback(
    async (items: ChannelVideo[], type: JobType) => {
      if (items.length === 0) {
        return;
      }
      try {
        // ids only: the server derives the URL, and a channel can have
        // thousands of videos — titles/urls would blow up the request body
        const result = await enqueue(
          items.map((video) => ({ videoId: video.id })),
          type,
        );
        const verb = type === 'update' ? t('toast.updateTarget') : t('toast.downloadTarget');
        toast.success(t('toast.addedToQueue', { count: result.jobs.length, target: verb }));
        const [firstSkipped] = result.skipped;
        if (firstSkipped) {
          toast.error(t('toast.skipped', { count: result.skipped.length, reason: firstSkipped.reason }));
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t('toast.enqueueFailed'));
      }
    },
    [enqueue, t],
  );

  // Stable per-render callbacks: VideoItem is memoized and a new callback
  // identity on every queue poll would defeat the memo
  const handleEnqueueOne = useCallback(
    (video: ChannelVideo, type: JobType) => {
      void enqueueVideos([video], type);
    },
    [enqueueVideos],
  );

  const handleCancel = useCallback(
    (jobId: string) => {
      cancel(jobId).catch((err) => logError(err));
    },
    [cancel],
  );

  // Rows carry their "last updated" date; memoized so a queue poll does not
  // rebuild every row object (VideoItem is memoized on prop identity)
  const rows = useMemo(
    () => videos.map((video) => ({ ...video, lastUpdated: lastUpdatedDates[video.id] })),
    [videos, lastUpdatedDates],
  );

  // Windowed list: only the visible rows (plus overscan) exist in the DOM,
  // so a channel with thousands of videos stays responsive. Rows with an
  // active/errored job are taller to fit the log.
  // Stable row renderer for the windowed list (react-window 2 re-renders
  // rows when this identity changes, so it must be memoized).
  const renderRow = useCallback(
    ({ index, style, ariaAttributes }: RowComponentProps): JSX.Element | null => {
      const video = rows[index];
      if (!video) {
        return null;
      }
      return (
        // The list container carries role="list", so the rows have to take
        // the role="listitem" react-window hands out here; without it the
        // list had no items at all for assistive tech.
        <div style={style} {...ariaAttributes}>
          <VideoItem
            video={video}
            isDownloaded={downloadStatuses[video.id] || false}
            job={video.id ? jobsByVideoId[video.id] : undefined}
            onEnqueue={handleEnqueueOne}
            onCancel={handleCancel}
          />
        </div>
      );
    },
    [rows, downloadStatuses, jobsByVideoId, handleEnqueueOne, handleCancel],
  );

  // When a job starts running, bring its row into view. The windowed list is
  // the source of truth — scrollToItem knows the row's exact offset (the
  // per-item scrollIntoView fallback that used to live in VideoItem could
  // not, and never ran because no container ref was passed down).
  const runningJobVideoId = useMemo(() => jobs.find((job) => job.status === 'running')?.videoId, [jobs]);
  useEffect(() => {
    if (!runningJobVideoId) {
      return;
    }
    const index = rows.findIndex((row) => row.id === runningJobVideoId);
    if (index >= 0) {
      listRef.current?.scrollToRow({ index, align: 'auto' });
    }
  }, [runningJobVideoId, rows, listRef]);

  // The three selections the bulk buttons work on. The rules live in
  // utils/videoSelection so the console's row actions cannot drift from them.
  const downloadable = useMemo(() => selectDownloadable(videos, downloadStatuses), [videos, downloadStatuses]);
  const downloaded = useMemo(() => selectDownloaded(videos, downloadStatuses), [videos, downloadStatuses]);
  const stale = useMemo(
    () => selectStale(videos, downloadStatuses, lastUpdatedDates),
    [videos, downloadStatuses, lastUpdatedDates],
  );

  // Bulk actions on big channels arm a confirmation first: one misclick used
  // to enqueue hundreds of downloads.
  const BULK_CONFIRM_THRESHOLD = 50;
  const [armedBulk, setArmedBulk] = useState<null | 'download' | 'update' | 'update-old'>(null);
  const armedTimerRef = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (armedTimerRef.current !== null) {
        window.clearTimeout(armedTimerRef.current);
      }
    };
  }, []);

  const requestBulk = (action: 'download' | 'update' | 'update-old') => {
    const items = action === 'download' ? downloadable : action === 'update' ? downloaded : stale;
    if (items.length === 0) {
      return;
    }
    if (items.length >= BULK_CONFIRM_THRESHOLD && armedBulk !== action) {
      setArmedBulk(action);
      if (armedTimerRef.current !== null) {
        window.clearTimeout(armedTimerRef.current);
      }
      armedTimerRef.current = window.setTimeout(() => setArmedBulk(null), 5000);
      return;
    }
    setArmedBulk(null);
    enqueueVideos(items, action === 'download' ? 'download' : 'update');
  };

  // Don't render anything if list doesn't exist
  if (listExists !== true) {
    return null;
  }

  const notDownloadedCount = downloadable.length;
  const downloadedCount = downloaded.length;
  const notUpdatedCount = stale.length;
  const runningCount = jobs.filter((job) => job.status === 'running').length;
  const queuedCount = activeCount - runningCount;

  return (
    <div className="videos-list-section">
      {videosError && <ErrorMessage compact>{t('app.error', { message: videosError })}</ErrorMessage>}
      {queueError && <ErrorMessage compact>{t('queue.queueError', { message: queueError })}</ErrorMessage>}
      {isLoadingVideos ? (
        <p>{t('queue.loadingVideos')}</p>
      ) : videos.length > 0 ? (
        <div className="videos-list">
          <VideoListHeader
            videosCount={videos.length}
            notDownloadedCount={notDownloadedCount}
            downloadedCount={downloadedCount}
            notUpdatedCount={notUpdatedCount}
            runningCount={runningCount}
            queuedCount={queuedCount}
            hasActive={hasActive}
            armedBulk={armedBulk}
            onDownloadAll={() => requestBulk('download')}
            onUpdateOld={() => requestBulk('update-old')}
            onUpdateAll={() => requestBulk('update')}
            onCancelAll={() => void cancelAll().catch(() => undefined)}
          />
          <div className="videos-list-items">
            <List
              listRef={listRef}
              rowCount={rows.length}
              rowHeight={rowHeight}
              rowKey={(index) => rows[index]?.id ?? `index-${index}`}
              rowProps={ROW_PROPS}
              overscanCount={8}
              rowComponent={renderRow}
            />
          </div>
        </div>
      ) : hasLoadedVideos ? (
        <p>{t('queue.emptyList')}</p>
      ) : null}
    </div>
  );
}
