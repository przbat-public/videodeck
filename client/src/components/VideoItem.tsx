import { useEffect, useState, useRef, useImperativeHandle, forwardRef } from 'react';
import { Link } from 'react-router-dom';

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
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadOutput, setDownloadOutput] = useState<string[]>([]);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const itemRef = useRef<HTMLDivElement>(null);
  const outputRef = useRef<HTMLDivElement>(null);
  const downloadPromiseRef = useRef<{ resolve: () => void; reject: (error: Error) => void } | null>(null);

  useImperativeHandle(ref, () => ({
    startDownload: () => {
      return new Promise<void>((resolve, reject) => {
        if (!isDownloaded && !isDownloading && video.url) {
          downloadPromiseRef.current = { resolve, reject };
          handleDownload();
        } else {
          resolve();
        }
      });
    },
    isDownloading: () => isDownloading,
    scrollIntoView: () => {
      itemRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
  }));

  // Auto-scroll output to bottom when new output arrives
  useEffect(() => {
    if (isDownloading && outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [downloadOutput, isDownloading]);

  const handleDownload = () => {
    if (!video.url) {
      setDownloadError('Brak URL filmu');
      return;
    }

    setIsDownloading(true);
    setDownloadOutput([]);
    setDownloadError(null);
    onDownloadStarted?.();

    // Use fetch with streaming for SSE-like behavior
    fetch('/api/folder/download-video', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        folderPath,
        videoUrl: video.url,
      }),
    })
      .then((response) => {
        if (!response.ok) {
          throw new Error('Failed to start download');
        }

        const reader = response.body?.getReader();
        const decoder = new TextDecoder();

        if (!reader) {
          throw new Error('No response body');
        }

        const readStream = () => {
          reader.read().then(({ done, value }) => {
            if (done) {
              setIsDownloading(false);
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
                    setDownloadOutput((prev) => [...prev, data.message]);
                  } else if (data.type === 'error') {
                    setDownloadError(data.error || 'Unknown error');
                    setIsDownloading(false);
                    // Reject promise on error
                    if (downloadPromiseRef.current) {
                      downloadPromiseRef.current.reject(new Error(data.error || 'Unknown error'));
                      downloadPromiseRef.current = null;
                    }
                  } else if (data.type === 'done') {
                    setIsDownloading(false);
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
          });
        };

        readStream();
      })
      .catch((err) => {
        setDownloadError(err.message || 'Failed to start download');
        setIsDownloading(false);
        // Reject promise on error
        if (downloadPromiseRef.current) {
          downloadPromiseRef.current.reject(err instanceof Error ? err : new Error(err.message || 'Failed to start download'));
          downloadPromiseRef.current = null;
        }
      });
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
            <span className="video-status downloaded">✓ Pobrany</span>
          ) : (
            <button
              className="download-video-button"
              onClick={handleDownload}
              disabled={isDownloading}
            >
              {isDownloading ? 'Pobieranie...' : 'Pobierz'}
            </button>
          )}
        </div>
      </div>
      {isDownloading && (
        <div className="download-output">
          {downloadError && (
            <div className="download-error">
              <p>Błąd: {downloadError}</p>
            </div>
          )}
          <div className="download-output-content" ref={outputRef}>
            {downloadOutput.map((line, index) => (
              <div key={index} className="output-line">{line}</div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
});

VideoItem.displayName = 'VideoItem';

