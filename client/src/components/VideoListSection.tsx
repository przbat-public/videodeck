import type {
  ChannelVideo,
  DownloadState,
  EnqueueJobsResponse,
  FolderStateResponse,
  JobType,
  QueueJob,
} from '@videodeck/shared/api';
import { FolderListResponseSchema } from '@videodeck/shared/schemas';
import type { TFunction } from 'i18next';
import type { JSX, RefObject } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import type { DynamicRowHeight, ListImperativeAPI } from 'react-window';
import { List, type RowComponentProps, useDynamicRowHeight, useListRef } from 'react-window';
import { useDownloadQueue } from '../hooks/useDownloadQueue';
import { useFolderState } from '../hooks/useFolderState';
import { apiGet } from '../utils/apiClient';
import { logError } from '../utils/logError';
import type { VideoStateFilter, VideoStateFilterOption } from '../utils/videoState';
import { isOnDisk, matchesVideoFilter, skipReasonText, VIDEO_STATE_FILTERS } from '../utils/videoState';
import { ErrorMessage } from './ui/ErrorMessage';
import type { ChannelVideoRow } from './VideoItem';
import { VideoItem } from './VideoItem';
import { VideoStatePanel } from './VideoStatePanel';

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

/** A row of the windowed list: the orphan explanation, or one video */
type ListEntry = { kind: 'orphanHeader' } | { kind: 'video'; row: VideoRow };

/** A `list.json` row joined with what the folder state says is on disk */
interface VideoRow extends ChannelVideoRow {
  /** Absent while `/api/folder/state` has not answered for this folder */
  downloadState?: DownloadState | undefined;
}

interface VideoListSectionProps {
  folderPath: string;
  listExists: boolean;
  /**
   * A collection (`kind: "collection"`) has no `list.json` by design: its
   * videos live in the folder index, so the server reports every one of them
   * as an orphan. Nothing is "no longer listed" there.
   */
  collection?: boolean;
  /**
   * Bumped by the page when something outside this section queued or
   * cancelled work for the folder (the console row's bulk actions). The poll
   * below runs only while the section sees active jobs, so an idle section
   * needs to be told that its folder's queue moved.
   */
  queueRevision?: number;
  /** A job was queued or cancelled here; the console re-reads the whole queue */
  onQueueChanged?: () => void;
}

/** Stable react-window key for one entry of the list */
function entryKey(entry: ListEntry | undefined, index: number): string {
  if (entry === undefined) {
    return `index-${index}`;
  }
  if (entry.kind === 'orphanHeader') {
    return 'orphans';
  }
  return entry.row.id || `index-${index}`;
}

interface VideoStateFiltersProps {
  options: readonly VideoStateFilterOption[];
  /** The chip that is on */
  filter: VideoStateFilter;
  counts: FolderStateResponse['counts'] | undefined;
  onChange: (next: VideoStateFilter) => void;
}

/** The count behind one chip; 0 until the folder state answers with the totals */
function countFor(counts: FolderStateResponse['counts'] | undefined, value: VideoStateFilter): number {
  if (counts === undefined) {
    return 0;
  }
  switch (value) {
    case 'incomplete':
      return counts.incomplete;
    case 'orphan':
      return counts.orphans;
    case 'not-downloaded':
      return counts.notDownloaded;
    default:
      // "All" is the catalog plus the videos only the disk still has
      return counts.videos + counts.orphans;
  }
}

/**
 * The filters above the video list. They narrow the videos of one folder, so
 * they live in the expanded row and not in the toolbar above the table, which
 * narrows channels. The fieldset groups them and its hidden legend names the
 * group for assistive tech.
 */
function VideoStateFilters({ options, filter, counts, onChange }: VideoStateFiltersProps): JSX.Element {
  const { t } = useTranslation();
  return (
    <fieldset className="video-state-filters">
      <legend className="visually-hidden">{t('videoState.filtersLabel')}</legend>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className="video-state-chip"
          aria-pressed={filter === option.value}
          onClick={() => onChange(option.value)}
        >
          {t(option.labelKey, { count: countFor(counts, option.value) })}
        </button>
      ))}
    </fieldset>
  );
}

/**
 * What the queue took and what it refused, in the reader's language. The
 * server's skip reasons are English machine strings (`not downloaded`), so
 * they go through the catalog instead of reaching the screen raw.
 */
function reportEnqueue(result: EnqueueJobsResponse, type: JobType, t: TFunction): void {
  const verb = t(type === 'update' ? 'toast.updateTarget' : 'toast.downloadTarget');
  toast.success(t('toast.addedToQueue', { count: result.jobs.length, target: verb }));
  const [firstSkipped] = result.skipped;
  if (firstSkipped !== undefined) {
    toast.error(
      t('toast.skipped', {
        count: result.skipped.length,
        reason: skipReasonText(firstSkipped.reason, t),
      }),
    );
  }
}

interface VideoListBodyProps {
  isLoadingVideos: boolean;
  hasLoadedVideos: boolean;
  filter: VideoStateFilter;
  entries: ListEntry[];
  rowHeight: DynamicRowHeight;
  listRef: RefObject<ListImperativeAPI | null>;
  renderRow: (props: RowComponentProps) => JSX.Element | null;
}

/** The list itself, or the line that says why there is none */
function VideoListBody({
  isLoadingVideos,
  hasLoadedVideos,
  filter,
  entries,
  rowHeight,
  listRef,
  renderRow,
}: VideoListBodyProps): JSX.Element | null {
  const { t } = useTranslation();
  if (isLoadingVideos) {
    return <p>{t('queue.loadingVideos')}</p>;
  }
  if (entries.length > 0) {
    // The expanded cell is the surface these rows sit on, so the list is the
    // scroll viewport and nothing else: react-window paints its items straight
    // into it, one element below the cell
    return (
      <List
        className="videos-list"
        listRef={listRef}
        rowCount={entries.length}
        rowHeight={rowHeight}
        rowKey={(index) => entryKey(entries[index], index)}
        rowProps={ROW_PROPS}
        overscanCount={8}
        rowComponent={renderRow}
      />
    );
  }
  if (!hasLoadedVideos) {
    return null;
  }
  // A filter that matched nothing is not the empty channel of `list.json`
  return <p>{filter === 'all' ? t('queue.emptyList') : t('videoState.empty')}</p>;
}

/**
 * A channel's videos with their download state, loaded as soon as the section
 * opens: the console's "show videos" toggle is the whole gesture, and the list
 * it promises is already there when the rows render. A folder without a
 * `list.json` has nothing to show and renders nothing at all.
 *
 * Two requests feed this view. `GET /api/folder/list` is the list itself: one
 * row per video, in the channel's order, with the download statuses and the
 * "last updated" dates. `GET /api/folder/state` adds what that endpoint cannot
 * answer — what each video has on disk, which videos only exist on disk, how
 * far `archive.txt` has drifted — and it is the one the filter chips talk to.
 * The two are joined by video id, so neither endpoint has to know the other.
 */
export function VideoListSection({
  folderPath,
  listExists,
  collection = false,
  queueRevision = 0,
  onQueueChanged,
}: VideoListSectionProps): JSX.Element | null {
  const [videos, setVideos] = useState<ChannelVideo[]>([]);
  const [downloadStatuses, setDownloadStatuses] = useState<Record<string, boolean>>({});
  const [lastUpdatedDates, setLastUpdatedDates] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState<VideoStateFilter>('all');
  const [openVideoId, setOpenVideoId] = useState<string | null>(null);
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

  const {
    state: folderState,
    error: stateError,
    refresh: refreshState,
  } = useFolderState(folderPath, { filter, enabled: listExists });

  const fetchList = useCallback(async () => {
    const data = await apiGet(
      `/api/folder/list?folderPath=${encodeURIComponent(folderPath)}`,
      FolderListResponseSchema,
      {
        message: t('errors.loadVideos'),
      },
    );
    setVideos(data.videos);
    setDownloadStatuses(data.downloadStatuses);
    setLastUpdatedDates(data.lastUpdatedDates);
    setHasLoadedVideos(true);
  }, [folderPath, t]);

  // Visible reload (spinner): the section runs it on open, and the drained
  // queue runs it again to pick up the exact dates the server wrote
  const loadVideos = useCallback(async () => {
    try {
      setIsLoadingVideos(true);
      setVideosError(null);
      await fetchList();
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : t('errors.occurred');
      setVideosError(errorMessage);
      logError(err);
    } finally {
      setIsLoadingVideos(false);
    }
  }, [fetchList, t]);

  // The console's "show videos" toggle opens this section, which is the same
  // decision as loading the list: the rows arrive on their own instead of
  // behind a second button. Re-runs when the folder changes (loadVideos
  // depends on it) and when a playlist fetch turns a missing list into a real
  // one under an already open row.
  useEffect(() => {
    if (listExists) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- mount fetch, the update lands after the await (see the rule note in eslint.config.mjs)
      void loadVideos();
    }
  }, [listExists, loadVideos]);

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
    // A finished download or repair changed the disk, so the badges are stale
    refreshState();
  }, [fetchList, refreshState]);

  const handleQueueChanged = useCallback(() => {
    onQueueChanged?.();
  }, [onQueueChanged]);

  // Destructured so the useCallback dependencies below reference the stable
  // members directly instead of the whole (freshly created) queue object
  const {
    jobs,
    error: queueError,
    refresh,
    enqueue,
    cancel,
    jobsByVideoId,
  } = useDownloadQueue(folderPath, {
    enabled: listExists,
    onJobFinished: handleJobFinished,
    onQueueDrained: handleQueueDrained,
    onQueueChanged: handleQueueChanged,
  });

  // A row action in the console queued work for this folder: read the jobs the
  // section did not create. The ref keeps the mount fetch from running twice.
  // The disk has not changed yet, so the badges wait for the queue to drain.
  const seenQueueRevisionRef = useRef(queueRevision);
  useEffect(() => {
    if (queueRevision === seenQueueRevisionRef.current) {
      return;
    }
    seenQueueRevisionRef.current = queueRevision;
    void refresh();
  }, [queueRevision, refresh]);

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
    setFilter('all');
    setOpenVideoId(null);
  }

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
        reportEnqueue(result, type, t);
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

  const handleToggleDetails = useCallback((video: ChannelVideo) => {
    setOpenVideoId((previous) => (previous === video.id ? null : video.id));
  }, []);

  // A repair queued from the panel changed the queue and will change the disk
  const handlePanelQueueChanged = useCallback(() => {
    void refresh();
    refreshState();
    onQueueChanged?.();
  }, [refresh, refreshState, onQueueChanged]);

  // What the folder state says about each row of list.json, by video id. A
  // collection has no list.json, so the server hands its videos over as
  // orphans; there they are the state of the very rows this list renders.
  const stateById = useMemo(() => {
    const byId = new Map<string, ChannelVideo>();
    for (const video of folderState?.videos ?? []) {
      byId.set(video.id, video);
    }
    if (collection) {
      for (const video of folderState?.orphans ?? []) {
        byId.set(video.id, video);
      }
    }
    return byId;
  }, [collection, folderState]);

  // Rows carry their "last updated" date and their on-disk state; memoized so
  // a queue poll does not rebuild every row object (VideoItem is memoized on
  // prop identity)
  const catalogRows = useMemo(
    () =>
      videos.map((video) => ({
        ...video,
        lastUpdated: lastUpdatedDates[video.id],
        downloadState: stateById.get(video.id)?.downloadState,
      })),
    [lastUpdatedDates, stateById, videos],
  );

  // The state is the authority for what survives a chip. While it has not
  // answered (still reading, or the read failed) the list shows every row
  // instead of pretending the filter matched nothing.
  const visibleRows = useMemo(() => {
    if (folderState === null) {
      return catalogRows;
    }
    return catalogRows.filter((row) => matchesVideoFilter(row.downloadState, filter));
  }, [catalogRows, filter, folderState]);

  // Videos on disk that the channel no longer lists. They are never mixed into
  // the catalog rows: a deleted video is not a missing download.
  const orphanRows = useMemo<VideoRow[]>(() => {
    if (collection) {
      return [];
    }
    return folderState?.orphans ?? [];
  }, [collection, folderState]);

  const entries = useMemo<ListEntry[]>(() => {
    const list: ListEntry[] = visibleRows.map((row) => ({ kind: 'video', row }));
    if (orphanRows.length > 0) {
      list.push({ kind: 'orphanHeader' });
      for (const row of orphanRows) {
        list.push({ kind: 'video', row });
      }
    }
    return list;
  }, [orphanRows, visibleRows]);

  // The chips the console offers for the videos of this folder. A collection
  // holds nothing else than what is on disk, so it has no "orphans" chip.
  const filterOptions = useMemo(
    () => (collection ? VIDEO_STATE_FILTERS.filter((option) => option.value !== 'orphan') : VIDEO_STATE_FILTERS),
    [collection],
  );

  // Windowed list: only the visible rows (plus overscan) exist in the DOM,
  // so a channel with thousands of videos stays responsive. Rows with an
  // active/errored job are taller to fit the log.
  // Stable row renderer for the windowed list (react-window 2 re-renders
  // rows when this identity changes, so it must be memoized).
  const renderRow = useCallback(
    ({ index, style, ariaAttributes }: RowComponentProps): JSX.Element | null => {
      const entry = entries[index];
      if (entry === undefined) {
        return null;
      }
      if (entry.kind === 'orphanHeader') {
        return (
          // The list container carries role="list", so the header takes the
          // role react-window hands its items: it counts in aria-setsize and
          // explains the rows under it rather than interrupting them.
          <div style={style} {...ariaAttributes} className="video-list-group">
            <p className="video-list-group-title">{t('videoState.orphanTitle')}</p>
            <p className="video-list-group-hint">{t('videoState.orphanHint')}</p>
          </div>
        );
      }
      const { row } = entry;
      // The list endpoint's status is the authority; the state answers for the
      // rows it never mentions, which is every orphan
      const isDownloaded = downloadStatuses[row.id] ?? isOnDisk(row.downloadState);
      return (
        // The list container carries role="list", so the rows have to take
        // the role="listitem" react-window hands out here; without it the
        // list had no items at all for assistive tech.
        <div style={style} {...ariaAttributes}>
          <VideoItem
            video={row}
            isDownloaded={isDownloaded}
            job={row.id ? jobsByVideoId[row.id] : undefined}
            onEnqueue={handleEnqueueOne}
            onCancel={handleCancel}
            detailsOpen={openVideoId === row.id}
            onToggleDetails={handleToggleDetails}
          />
          {openVideoId === row.id && (
            <VideoStatePanel
              folderPath={folderPath}
              video={{ id: row.id, title: row.title }}
              onQueueChanged={handlePanelQueueChanged}
            />
          )}
        </div>
      );
    },
    [
      downloadStatuses,
      entries,
      folderPath,
      handleCancel,
      handleEnqueueOne,
      handlePanelQueueChanged,
      handleToggleDetails,
      jobsByVideoId,
      openVideoId,
      t,
    ],
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
    const index = entries.findIndex((entry) => entry.kind === 'video' && entry.row.id === runningJobVideoId);
    if (index >= 0) {
      listRef.current?.scrollToRow({ index, align: 'auto' });
    }
  }, [runningJobVideoId, entries, listRef]);

  // Don't render anything if list doesn't exist
  if (listExists !== true) {
    return null;
  }

  return (
    <>
      {videosError && <ErrorMessage compact>{t('app.error', { message: videosError })}</ErrorMessage>}
      {queueError && <ErrorMessage compact>{t('queue.queueError', { message: queueError })}</ErrorMessage>}
      {stateError && <ErrorMessage compact>{t('app.error', { message: stateError })}</ErrorMessage>}
      {folderState !== null && (
        <VideoStateFilters options={filterOptions} filter={filter} counts={folderState.counts} onChange={setFilter} />
      )}
      <VideoListBody
        isLoadingVideos={isLoadingVideos}
        hasLoadedVideos={hasLoadedVideos}
        filter={filter}
        entries={entries}
        rowHeight={rowHeight}
        listRef={listRef}
        renderRow={renderRow}
      />
    </>
  );
}
