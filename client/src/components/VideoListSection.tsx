import { useState, useEffect, useRef } from 'react';
import { VideoItem, VideoListItem, VideoItemHandle } from './VideoItem';

interface VideoListSectionProps {
  folderPath: string;
  listExists: boolean;
}

export function VideoListSection({ folderPath, listExists }: VideoListSectionProps) {
  const [videos, setVideos] = useState<VideoListItem[]>([]);
  const [downloadStatuses, setDownloadStatuses] = useState<Record<string, boolean>>({});
  const [lastUpdatedDates, setLastUpdatedDates] = useState<Record<string, string>>({});
  const [isLoadingVideos, setIsLoadingVideos] = useState(false);
  const [videosError, setVideosError] = useState<string | null>(null);
  const [isDownloadingAll, setIsDownloadingAll] = useState(false);
  const [isUpdatingAll, setIsUpdatingAll] = useState(false);
  const videoItemRefs = useRef<Map<string, VideoItemHandle>>(new Map());
  const videosListContainerRef = useRef<HTMLDivElement>(null);

  // Load videos from list.json when it exists
  useEffect(() => {
    if (listExists) {
      const loadVideos = async () => {
        try {
          setIsLoadingVideos(true);
          setVideosError(null);
          const response = await fetch(`/api/folder/list?folderPath=${encodeURIComponent(folderPath)}`);
          if (!response.ok) {
            throw new Error('Failed to load videos');
          }
          const data = await response.json();

          setVideos(data.videos || []);
          setDownloadStatuses(data.downloadStatuses || {});
          setLastUpdatedDates(data.lastUpdatedDates || {});
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : 'An error occurred';
          setVideosError(errorMessage);
          console.error('Error loading videos:', err);
        } finally {
          setIsLoadingVideos(false);
        }
      };
      loadVideos();
    } else {
      setVideos([]);
      setDownloadStatuses({});
      setLastUpdatedDates({});
      setVideosError(null);
    }
  }, [listExists, folderPath]);

  const handleDownloadComplete = async (videoId: string) => {
    // Update local state
    setDownloadStatuses((prev) => ({
      ...prev,
      [videoId]: true,
    }));
    
    // Update last updated date locally immediately
    const currentDate = new Date().toISOString();
    setLastUpdatedDates((prev) => ({
      ...prev,
      [videoId]: currentDate,
    }));
    
    // Optionally refresh from backend to get exact file modification time
    // (runs in background, doesn't block UI update)
    try {
      const response = await fetch(`/api/folder/list?folderPath=${encodeURIComponent(folderPath)}`);
      if (response.ok) {
        const data = await response.json();
        if (data.lastUpdatedDates && data.lastUpdatedDates[videoId]) {
          // Update with backend value (more accurate - actual file modification time)
          setLastUpdatedDates((prev) => ({
            ...prev,
            [videoId]: data.lastUpdatedDates[videoId],
          }));
        }
      }
    } catch (err) {
      // Silently fail - local date is already set, backend date will be updated on next full refresh
      console.error('Error refreshing last updated date from backend:', err);
    }
  };

  const handleDownloadAll = async () => {
    const videosToDownload = videos.filter(
      (video) => !downloadStatuses[video.id] && video.url
    );

    if (videosToDownload.length === 0) {
      return;
    }

    setIsDownloadingAll(true);

    for (const video of videosToDownload) {
      // Find the index in the original videos array to match the key used in callback ref
      const index = videos.findIndex((v) => v === video);
      const videoId = video.id || `index-${index}`;
      const ref = videoItemRefs.current.get(videoId);
      
      if (!ref) {
        continue;
      }
      
      // Wait a bit before starting next download to ensure UI updates
      await new Promise((resolve) => setTimeout(resolve, 500));
      
      // Scroll to video
      ref.scrollIntoView();
      
      try {
        // Start download and wait for it to complete
        await ref.startDownload();
        
        // Update local state after successful download
        handleDownloadComplete(video.id);
      } catch (error) {
        console.error(`Error downloading video ${video.title}:`, error);
        // Continue with next video even if one fails
      }
    }

    setIsDownloadingAll(false);
  };

  // Helper function to check if video is older than a month
  const isVideoOlderThanMonth = (video: VideoListItem): boolean => {
    if (!downloadStatuses[video.id] || !video.url) return false;
    const lastUpdated = lastUpdatedDates[video.id];
    if (!lastUpdated) return true; // No date means not updated
    try {
      const oneMonthAgo = new Date();
      oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
      const updateDate = new Date(lastUpdated);
      return updateDate < oneMonthAgo;
    } catch {
      return true; // Invalid date means not updated
    }
  };

  const handleUpdateOld = async () => {
    // Check for videos not updated in over a month
    const videosToUpdate = videos.filter(isVideoOlderThanMonth);

    if (videosToUpdate.length === 0) {
      return;
    }

    setIsUpdatingAll(true);

    for (const video of videosToUpdate) {
      // Find the index in the original videos array to match the key used in callback ref
      const index = videos.findIndex((v) => v === video);
      const videoId = video.id || `index-${index}`;
      const ref = videoItemRefs.current.get(videoId);
      
      if (!ref) {
        continue;
      }
      
      // Wait a bit before starting next update to ensure UI updates
      await new Promise((resolve) => setTimeout(resolve, 500));
      
      // Scroll to video
      ref.scrollIntoView();
      
      try {
        // Start update and wait for it to complete
        await ref.startUpdate();
        // Update last updated date after successful update
        await handleDownloadComplete(video.id);
      } catch (error) {
        console.error(`Error updating video ${video.title}:`, error);
        // Continue with next video even if one fails
      }
    }

    setIsUpdatingAll(false);
  };

  if (listExists !== true) {
    return null;
  }

  // Calculate counts before render
  const notDownloadedCount = videos.filter(
    (video) => !downloadStatuses[video.id] && video.url
  ).length;
  const downloadedCount = videos.filter(
    (video) => downloadStatuses[video.id] && video.url
  ).length;
  const notUpdatedCount = videos.filter(isVideoOlderThanMonth).length;
  const hasOldVideos = videos.some(isVideoOlderThanMonth);
  const hasNotDownloadedVideos = videos.some((video) => !downloadStatuses[video.id] && video.url);

  return (
    <div className="videos-list-section">
      <h4 className="videos-section-title">Lista filmów z list.json</h4>
      {videosError && (
        <div className="config-error">
          <p>Błąd: {videosError}</p>
        </div>
      )}
      {isLoadingVideos ? (
        <p>Ładowanie filmów...</p>
      ) : videos.length > 0 ? (
        <div className="videos-list">
          <div className="videos-list-header">
            <p className="videos-count">
              Liczba filmów: {videos.length}
              {notDownloadedCount > 0 && ` (${notDownloadedCount} nie pobranych)`}
              {notUpdatedCount > 0 && ` (${notUpdatedCount} nie zaktualizowanych od ponad miesiąca)`}
              {downloadedCount > 0 && notDownloadedCount === 0 && notUpdatedCount === 0 && ` (wszystkie pobrane)`}
            </p>
            <div className="videos-list-buttons">
              {hasNotDownloadedVideos && (
                <button
                  className="download-all-button"
                  onClick={handleDownloadAll}
                  disabled={isDownloadingAll}
                >
                  {isDownloadingAll ? 'Pobieranie wszystkich...' : 'Pobierz wszystkie'}
                </button>
              )}
              {hasOldVideos && (
                <button
                  className="update-old-button"
                  onClick={handleUpdateOld}
                  disabled={isUpdatingAll}
                >
                  {isUpdatingAll ? 'Aktualizowanie ...' : 'Aktualizuj'}
                </button>
              )}
            </div>
          </div>
          <div className="videos-list-items" ref={videosListContainerRef}>
            {videos.map((video, index) => {
              const videoId = video.id || `index-${index}`;
              const videoWithLastUpdated = {
                ...video,
                lastUpdated: lastUpdatedDates[video.id]
              };
              return (
                  <VideoItem 
                  key={videoId} 
                  ref={(ref) => {
                    if (ref) {
                      videoItemRefs.current.set(videoId, ref);
                    } else {
                      videoItemRefs.current.delete(videoId);
                    }
                  }}
                  video={videoWithLastUpdated} 
                  folderPath={folderPath}
                  isDownloaded={downloadStatuses[video.id] || false}
                  onDownloadComplete={() => handleDownloadComplete(video.id)}
                  scrollContainerRef={videosListContainerRef}
                />
              );
            })}
          </div>
        </div>
      ) : (
        <p>Brak filmów w pliku list.json</p>
      )}
    </div>
  );
}

