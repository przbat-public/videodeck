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
          // Sort videos by title
          const sortedVideos = (data.videos || []).sort((a: VideoListItem, b: VideoListItem) => {
            const titleA = a.title.toLowerCase();
            const titleB = b.title.toLowerCase();
            return titleA.localeCompare(titleB);
          });
          setVideos(sortedVideos);
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

  const refreshDownloadStatuses = async () => {
    try {
      const response = await fetch(`/api/folder/list?folderPath=${encodeURIComponent(folderPath)}`);
      if (response.ok) {
        const data = await response.json();
        setDownloadStatuses(data.downloadStatuses || {});
      }
    } catch (err) {
      console.error('Error refreshing download statuses:', err);
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
        
        // Refresh statuses after each download
        await refreshDownloadStatuses();
      } catch (error) {
        console.error(`Error downloading video ${video.title}:`, error);
        // Continue with next video even if one fails
      }
    }

    setIsDownloadingAll(false);
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
            <p className="videos-count">Liczba filmów: {videos.length}</p>
            {videos.some((video) => !downloadStatuses[video.id] && video.url) && (
              <button
                className="download-all-button"
                onClick={handleDownloadAll}
                disabled={isDownloadingAll}
              >
                {isDownloadingAll ? 'Pobieranie wszystkich...' : 'Pobierz wszystkie'}
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
                  onDownloadComplete={refreshDownloadStatuses}
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

