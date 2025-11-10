import { useState, useEffect, useRef } from 'react';
import { VideoItem, VideoListItem, VideoItemHandle } from './VideoItem';

interface VideoListSectionProps {
  folderPath: string;
  listExists: boolean;
}

export function VideoListSection({ folderPath, listExists }: VideoListSectionProps) {
  const [videos, setVideos] = useState<VideoListItem[]>([]);
  const [downloadStatuses, setDownloadStatuses] = useState<Record<string, boolean>>({});
  const [isLoadingVideos, setIsLoadingVideos] = useState(false);
  const [videosError, setVideosError] = useState<string | null>(null);
  const [isDownloadingAll, setIsDownloadingAll] = useState(false);
  const [isUpdatingAll, setIsUpdatingAll] = useState(false);
  const videoItemRefs = useRef<Map<string, VideoItemHandle>>(new Map());

  // Load videos from list.json when it exists
  useEffect(() => {
    if (listExists === true) {
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
      setVideosError(null);
    }
  }, [listExists, folderPath]);

  const handleDownloadComplete = (videoId: string) => {
    // Update local state instead of fetching from backend
    setDownloadStatuses((prev) => ({
      ...prev,
      [videoId]: true,
    }));
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

  const handleUpdateAll = async () => {
    const videosToUpdate = videos.filter(
      (video) => downloadStatuses[video.id] && video.url
    );

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
        // Note: Status remains true after update, no need to update state
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
            {(() => {
              const notDownloadedCount = videos.filter(
                (video) => !downloadStatuses[video.id] && video.url
              ).length;
              const downloadedCount = videos.filter(
                (video) => downloadStatuses[video.id] && video.url
              ).length;
              return (
                <p className="videos-count">
                  Liczba filmów: {videos.length}
                  {notDownloadedCount > 0 && ` (${notDownloadedCount} nie pobranych)`}
                  {downloadedCount > 0 && notDownloadedCount === 0 && ` (wszystkie pobrane)`}
                </p>
              );
            })()}
            {videos.some((video) => !downloadStatuses[video.id] && video.url) && (
              <button
                className="download-all-button"
                onClick={handleDownloadAll}
                disabled={isDownloadingAll}
              >
                {isDownloadingAll ? 'Pobieranie wszystkich...' : 'Pobierz wszystkie'}
              </button>
            )}
            {videos.some((video) => downloadStatuses[video.id] && video.url) && 
             !videos.some((video) => !downloadStatuses[video.id] && video.url) && (
              <button
                className="update-all-button"
                onClick={handleUpdateAll}
                disabled={isUpdatingAll}
              >
                {isUpdatingAll ? 'Aktualizowanie wszystkich...' : 'Aktualizuj wszystkie'}
              </button>
            )}
          </div>
          <div className="videos-list-items">
            {videos.map((video, index) => {
              const videoId = video.id || `index-${index}`;
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
                  video={video} 
                  folderPath={folderPath}
                  isDownloaded={downloadStatuses[video.id] || false}
                  onDownloadComplete={() => handleDownloadComplete(video.id)}
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

