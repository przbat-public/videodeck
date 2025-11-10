import { useEffect, useReducer, useRef, useImperativeHandle, forwardRef } from 'react';
import { Link } from 'react-router-dom';
import {
  videoDownloadReducer,
  initialDownloadState,
  VideoDownloadActionType,
} from '../reducers/videoDownloadReducer';

export interface VideoListItem {
  title: string;
  url: string;
  id: string;
}

export interface VideoItemProps {
  video: VideoListItem;
  folderPath: string;
  isDownloaded: boolean;
  onDownloadComplete: () => void;
  onDownloadStarted?: () => void;
}

export interface VideoItemHandle {
  startDownload: () => Promise<void>;
  startUpdate: () => Promise<void>;
  isDownloading: () => boolean;
  scrollIntoView: () => void;
}

export const VideoItem = forwardRef<VideoItemHandle, VideoItemProps>(({ 
  video, 
  folderPath, 
  isDownloaded, 
  onDownloadComplete,
  onDownloadStarted 
}, ref) => {
  const [downloadState, dispatch] = useReducer(videoDownloadReducer, initialDownloadState);
  const itemRef = useRef<HTMLDivElement>(null);
  const outputRef = useRef<HTMLDivElement>(null);
  const downloadPromiseRef = useRef<{ resolve: () => void; reject: (error: Error) => void } | null>(null);

  useImperativeHandle(ref, () => ({
    startDownload: () => {
      return new Promise<void>((resolve, reject) => {
        if (!isDownloaded && !downloadState.isDownloading && video.url) {
          downloadPromiseRef.current = { resolve, reject };
          handleDownload();
        } else {
          resolve();
        }
      });
    },
    startUpdate: () => {
      return new Promise<void>((resolve, reject) => {
        if (isDownloaded && !downloadState.isDownloading && video.url) {
          downloadPromiseRef.current = { resolve, reject };
          handleDownload();
        } else {
          resolve();
        }
      });
    },
    isDownloading: () => downloadState.isDownloading,
    scrollIntoView: () => {
      itemRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
  }));

  // Auto-scroll output to bottom when new output arrives
  useEffect(() => {
    if (downloadState.isDownloading && outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [downloadState.downloadOutput, downloadState.isDownloading]);

  const handleDownload = async () => {
    if (!video.url) {
      dispatch({ type: VideoDownloadActionType.SET_ERROR, payload: 'Brak URL filmu' });
      return;
    }

    dispatch({ type: VideoDownloadActionType.START_DOWNLOAD });
    onDownloadStarted?.();

    try {
      // Use fetch with streaming for SSE-like behavior
      const response = await fetch('/api/folder/download-video', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          folderPath,
          videoUrl: video.url,
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to start download');
      }

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();

      if (!reader) {
        throw new Error('No response body');
      }

      const readStream = async () => {
        try {
          const { done, value } = await reader.read();
          
          if (done) {
            dispatch({ type: VideoDownloadActionType.COMPLETE_DOWNLOAD });
            // Notify parent to refresh download statuses
            onDownloadComplete();
            // Resolve promise
            if (downloadPromiseRef.current) {
              downloadPromiseRef.current.resolve();
              downloadPromiseRef.current = null;
            }
            return;
          }

          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split('\n');

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const data = JSON.parse(line.substring(6));
                if (data.type === 'output' && data.message) {
                  dispatch({ type: VideoDownloadActionType.ADD_OUTPUT, payload: data.message });
                } else if (data.type === 'error') {
                  dispatch({ type: VideoDownloadActionType.SET_ERROR, payload: data.error || 'Unknown error' });
                  // Reject promise on error
                  if (downloadPromiseRef.current) {
                    downloadPromiseRef.current.reject(new Error(data.error || 'Unknown error'));
                    downloadPromiseRef.current = null;
                  }
                } else if (data.type === 'done') {
                  dispatch({ type: VideoDownloadActionType.COMPLETE_DOWNLOAD });
                  // Notify parent to refresh download statuses
                  onDownloadComplete();
                  // Resolve promise
                  if (downloadPromiseRef.current) {
                    downloadPromiseRef.current.resolve();
                    downloadPromiseRef.current = null;
                  }
                }
              } catch (e) {
                // Ignore parse errors
              }
            }
          }

          readStream();
        } catch (err) {
          dispatch({ type: VideoDownloadActionType.SET_ERROR, payload: err instanceof Error ? err.message : 'Unknown error' });
          // Reject promise on error
          if (downloadPromiseRef.current) {
            downloadPromiseRef.current.reject(err instanceof Error ? err : new Error('Unknown error'));
            downloadPromiseRef.current = null;
          }
        }
      };

      readStream();
    } catch (err) {
      dispatch({ type: VideoDownloadActionType.SET_ERROR, payload: err instanceof Error ? err.message : 'Failed to start download' });
      // Reject promise on error
      if (downloadPromiseRef.current) {
        downloadPromiseRef.current.reject(err instanceof Error ? err : new Error('Failed to start download'));
        downloadPromiseRef.current = null;
      }
    }
  };

  return (
    <div className="video-item" ref={itemRef}>
      <div className="video-item-header">
        {isDownloaded && video.id ? (
          <Link 
            to={`/video/${encodeURIComponent(video.id)}`}
            className="video-title-link"
          >
            {video.title || 'Brak tytułu'}
          </Link>
        ) : video.url ? (
          <a 
            href={video.url} 
            target="_blank" 
            rel="noopener noreferrer"
            className="video-title-link"
          >
            {video.title || 'Brak tytułu'}
          </a>
        ) : (
          <span className="video-title">{video.title || 'Brak tytułu'}</span>
        )}
        <div className="video-item-actions">
          {isDownloaded === true ? (
            <button
              className="update-video-button"
              onClick={handleDownload}
              disabled={downloadState.isDownloading}
            >
              {downloadState.isDownloading ? 'Aktualizowanie...' : 'Aktualizuj'}
            </button>
          ) : (
            <button
              className="download-video-button"
              onClick={handleDownload}
              disabled={downloadState.isDownloading}
            >
              {downloadState.isDownloading ? 'Pobieranie...' : 'Pobierz'}
            </button>
          )}
        </div>
      </div>
      {downloadState.isDownloading && (
        <div className="download-output">
          {downloadState.downloadError && (
            <div className="download-error">
              <p>Błąd: {downloadState.downloadError}</p>
            </div>
          )}
          <div className="download-output-content" ref={outputRef}>
            {downloadState.downloadOutput.map((line, index) => (
              <div key={index} className="output-line">{line}</div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
});

VideoItem.displayName = 'VideoItem';

