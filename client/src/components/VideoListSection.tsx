import { useState, useRef, useImperativeHandle, forwardRef, useCallback } from 'react';
import toast from 'react-hot-toast';
import type { ChannelVideo, FolderListResponse, JobType, QueueJob } from '@shared/api';
import { VideoItem } from './VideoItem';
import { useDownloadQueue } from '../hooks/useDownloadQueue';
import { isOlderThanMonth } from '../utils/videoDates';

interface VideoListSectionProps {
  folderPath: string;
  listExists: boolean;
}

export interface VideoListSectionHandle {
  loadVideos: () => Promise<void>;
}

export const VideoListSection = forwardRef<VideoListSectionHandle, VideoListSectionProps>(
  ({ folderPath, listExists }, ref) => {
    const [videos, setVideos] = useState<ChannelVideo[]>([]);
    const [downloadStatuses, setDownloadStatuses] = useState<Record<string, boolean>>({});
    const [lastUpdatedDates, setLastUpdatedDates] = useState<Record<string, string>>({});
    const [isLoadingVideos, setIsLoadingVideos] = useState(false);
    const [videosError, setVideosError] = useState<string | null>(null);
    const [hasLoadedVideos, setHasLoadedVideos] = useState(false);
    const videosListContainerRef = useRef<HTMLDivElement>(null);

    const fetchList = useCallback(async () => {
      const response = await fetch(`/api/folder/list?folderPath=${encodeURIComponent(folderPath)}`);
      if (!response.ok) {
        throw new Error('Failed to load videos');
      }
      const data: FolderListResponse = await response.json();
      setVideos(data.videos || []);
      setDownloadStatuses(data.downloadStatuses || {});
      setLastUpdatedDates(data.lastUpdatedDates || {});
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
        console.error('Error loading videos:', err);
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
      fetchList().catch((err) => console.error('Error refreshing video list:', err));
    }, [fetchList]);

    const queue = useDownloadQueue(folderPath, {
      onJobFinished: handleJobFinished,
      onQueueDrained: handleQueueDrained,
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

    const enqueueVideos = async (items: ChannelVideo[], type: JobType) => {
      if (items.length === 0) {
        return;
      }
      try {
        // ids only: the server derives the URL, and a channel can have
        // thousands of videos — titles/urls would blow up the request body
        const result = await queue.enqueue(
          items.map((video) => ({ videoId: video.id })),
          type
        );
        const verb = type === 'update' ? 'aktualizacji' : 'pobrania';
        toast.success(`Dodano ${result.jobs.length} filmów do ${verb}`);
        const [firstSkipped] = result.skipped;
        if (firstSkipped) {
          toast.error(`Pominięto ${result.skipped.length}: ${firstSkipped.reason}`);
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Nie udało się dodać do kolejki');
      }
    };

    const handleEnqueueOne = (video: ChannelVideo, type: JobType) => {
      void enqueueVideos([video], type);
    };

    const handleCancel = (jobId: string) => {
      queue.cancel(jobId).catch((err) => console.error('Error cancelling job:', err));
    };

    const isNotDownloaded = (video: ChannelVideo) => !downloadStatuses[video.id] && !!video.url;
    const isDownloaded = (video: ChannelVideo) => !!downloadStatuses[video.id] && !!video.url;
    const isVideoOlderThanMonth = (video: ChannelVideo) =>
      isDownloaded(video) && isOlderThanMonth(lastUpdatedDates[video.id]);

    const handleDownloadAll = () => enqueueVideos(videos.filter(isNotDownloaded), 'download');
    const handleUpdateOld = () => enqueueVideos(videos.filter(isVideoOlderThanMonth), 'update');

    // Don't render anything if list doesn't exist
    if (listExists !== true) {
      return null;
    }

    const notDownloadedCount = videos.filter(isNotDownloaded).length;
    const downloadedCount = videos.filter(isDownloaded).length;
    const notUpdatedCount = videos.filter(isVideoOlderThanMonth).length;
    const runningCount = queue.jobs.filter((job) => job.status === 'running').length;
    const queuedCount = queue.activeCount - runningCount;

    return (
      <div className="videos-list-section">
        {videosError && (
          <div className="config-error">
            <p>Błąd: {videosError}</p>
          </div>
        )}
        {queue.error && (
          <div className="config-error">
            <p>Błąd kolejki: {queue.error}</p>
          </div>
        )}
        {isLoadingVideos ? (
          <p>Ładowanie listy filmów ...</p>
        ) : videos.length > 0 ? (
          <div className="videos-list">
            <div className="videos-list-header">
              <p className="videos-count">
                Liczba filmów: {videos.length}
                {notDownloadedCount > 0 && ` (${notDownloadedCount} nie pobranych)`}
                {notUpdatedCount > 0 &&
                  ` (${notUpdatedCount} nie zaktualizowanych od ponad miesiąca)`}
                {downloadedCount > 0 &&
                  notDownloadedCount === 0 &&
                  notUpdatedCount === 0 &&
                  ' (wszystkie pobrane)'}
                {queue.hasActive && (
                  <span className="queue-summary">
                    kolejka: {runningCount} w toku, {queuedCount} czeka
                  </span>
                )}
              </p>
              <div className="videos-list-buttons">
                {notDownloadedCount > 0 && (
                  <button className="download-all-button" onClick={handleDownloadAll} type="button">
                    Pobierz wszystkie
                  </button>
                )}
                {notUpdatedCount > 0 && (
                  <button className="update-old-button" onClick={handleUpdateOld} type="button">
                    Aktualizuj stare
                  </button>
                )}
                {queue.hasActive && (
                  <button
                    className="cancel-all-button"
                    onClick={() => queue.cancelAll().catch(() => undefined)}
                    type="button"
                  >
                    Anuluj wszystko
                  </button>
                )}
              </div>
            </div>
            <div className="videos-list-items" ref={videosListContainerRef}>
              {videos.map((video, index) => {
                const key = video.id || `index-${index}`;
                return (
                  <VideoItem
                    key={key}
                    video={{ ...video, lastUpdated: lastUpdatedDates[video.id] }}
                    isDownloaded={downloadStatuses[video.id] || false}
                    job={video.id ? queue.jobsByVideoId[video.id] : undefined}
                    onEnqueue={handleEnqueueOne}
                    onCancel={handleCancel}
                    scrollContainerRef={videosListContainerRef}
                  />
                );
              })}
            </div>
          </div>
        ) : hasLoadedVideos ? (
          <p>Brak filmów w pliku list.json</p>
        ) : null}
      </div>
    );
  }
);

VideoListSection.displayName = 'VideoListSection';
