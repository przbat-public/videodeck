import { useEffect, useReducer, useState, useRef, useImperativeHandle, forwardRef } from 'react';
import { Link } from 'react-router-dom';
import {
  statusReducer,
  initialState,
  StatusActionType,
  StatusData,
  FolderConfig,
} from '../reducers/statusReducer';

interface FolderSectionProps {
  folderPath: string;
  initialConfig: FolderConfig | null;
  onConfigUpdate: (folderPath: string, config: FolderConfig | null) => void;
}

interface VideoListItem {
  title: string;
  url: string;
  id: string;
}

interface VideoItemProps {
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

const VideoItem = forwardRef<VideoItemHandle, VideoItemProps>(({ 
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
      itemRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
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

function FolderSection({ folderPath, initialConfig, onConfigUpdate }: FolderSectionProps): JSX.Element {
  const [config, setConfig] = useState<FolderConfig | null>(initialConfig);
  const [error, setError] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [channelUrl, setChannelUrl] = useState(initialConfig?.channelUrl || '');
  const [isSaving, setIsSaving] = useState(false);
  const [listExists, setListExists] = useState<boolean | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [videos, setVideos] = useState<VideoListItem[]>([]);
  const [downloadStatuses, setDownloadStatuses] = useState<Record<string, boolean>>({});
  const [isLoadingVideos, setIsLoadingVideos] = useState(false);
  const [videosError, setVideosError] = useState<string | null>(null);
  const [isDownloadingAll, setIsDownloadingAll] = useState(false);
  const videoItemRefs = useRef<Map<string, VideoItemHandle>>(new Map());

  // Update local state when initialConfig changes
  useEffect(() => {
    setConfig(initialConfig);
    setChannelUrl(initialConfig?.channelUrl || '');
  }, [initialConfig]);

  // Check if list.json exists when config is available
  useEffect(() => {
    if (config && config.channelUrl) {
      const checkListExists = async () => {
        try {
          const response = await fetch(`/api/folder/list-exists?folderPath=${encodeURIComponent(folderPath)}`);
          if (response.ok) {
            const data = await response.json();
            setListExists(data.exists);
          }
        } catch (err) {
          console.error('Error checking list.json:', err);
        }
      };
      checkListExists();
    } else {
      setListExists(null);
    }
  }, [config, folderPath]);

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

  const handleSave = async () => {
    try {
      setError(null);
      setIsSaving(true);
      const newConfig: FolderConfig = {
        channelUrl: channelUrl.trim() || undefined,
      };

      const response = await fetch('/api/folder/config', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          folderPath,
          config: newConfig,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || 'Failed to save config');
      }

      const result = await response.json();
      setConfig(result.config);
      onConfigUpdate(folderPath, result.config);
      setIsEditing(false);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'An error occurred';
      setError(errorMessage);
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancel = () => {
    setChannelUrl(config?.channelUrl || '');
    setIsEditing(false);
    setError(null);
  };

  const handleDownloadPlaylist = async () => {
    if (!config?.channelUrl) {
      setDownloadError('Brak skonfigurowanego adresu kanału YouTube');
      return;
    }

    try {
      setDownloadError(null);
      setIsDownloading(true);
      
      const response = await fetch('/api/folder/download-playlist', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          folderPath,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || 'Failed to download playlist');
      }

      // Refresh list existence status and reload videos
      const listResponse = await fetch(`/api/folder/list-exists?folderPath=${encodeURIComponent(folderPath)}`);
      if (listResponse.ok) {
        const listData = await listResponse.json();
        setListExists(listData.exists);
        // Trigger video reload by updating listExists
        if (listData.exists) {
          const videosResponse = await fetch(`/api/folder/list?folderPath=${encodeURIComponent(folderPath)}`);
          if (videosResponse.ok) {
            const videosData = await videosResponse.json();
            const sortedVideos = (videosData.videos || []).sort((a: VideoListItem, b: VideoListItem) => {
              const titleA = a.title.toLowerCase();
              const titleB = b.title.toLowerCase();
              return titleA.localeCompare(titleB);
            });
            setVideos(sortedVideos);
            setDownloadStatuses(videosData.downloadStatuses || {});
          }
        }
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'An error occurred';
      setDownloadError(errorMessage);
    } finally {
      setIsDownloading(false);
    }
  };

  return (
    <div className="folder-section">
      <div className="folder-section-header">
        <h3 className="folder-path">{folderPath}</h3>
      </div>
      
      <div className="folder-config">
        {error && (
          <div className="config-error">
            <p>Błąd: {error}</p>
          </div>
        )}

        {config === null ? (
          <div className="config-empty">
            <p>Plik config.json nie istnieje w tym folderze.</p>
            {!isEditing && (
              <button 
                className="create-config-button"
                onClick={() => setIsEditing(true)}
              >
                Utwórz config.json
              </button>
            )}
          </div>
        ) : (
          <div>
            {!isEditing && (
              <div className="config-info">
                <div className="config-field">
                  <label>Adres kanału YouTube:</label>
                  <p className="config-value">
                    {config.channelUrl || <em>Nie ustawiono</em>}
                  </p>
                </div>
                <button 
                  className="edit-config-button"
                  onClick={() => setIsEditing(true)}
                >
                  Edytuj konfigurację
                </button>
              </div>
            )}
          </div>
        )}

        {isEditing && (
          <div className="config-edit">
            <div className="config-field">
              <label htmlFor={`channelUrl-${folderPath}`}>
                Adres kanału YouTube:
              </label>
              <input
                id={`channelUrl-${folderPath}`}
                type="text"
                value={channelUrl}
                onChange={(e) => setChannelUrl(e.target.value)}
                placeholder="https://www.youtube.com/@channel"
                className="config-input"
              />
            </div>
            <div className="config-actions">
              <button 
                className="save-config-button"
                onClick={handleSave}
                disabled={isSaving}
              >
                {isSaving ? 'Zapisywanie...' : 'Zapisz'}
              </button>
              <button 
                className="cancel-config-button"
                onClick={handleCancel}
                disabled={isSaving}
              >
                Anuluj
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Playlist download section - only visible when config exists */}
      {config && config.channelUrl && (
        <div className="playlist-download-section">
          <h4 className="playlist-section-title">Pobieranie listy filmów</h4>
          {downloadError && (
            <div className="config-error">
              <p>Błąd: {downloadError}</p>
            </div>
          )}
          <div className="playlist-info">
            {listExists === null ? (
              <p>Sprawdzanie statusu pliku list.json...</p>
            ) : listExists ? (
              <p>Plik list.json już istnieje. Kliknij przycisk poniżej, aby zaktualizować listę filmów.</p>
            ) : (
              <p>Plik list.json nie istnieje. Kliknij przycisk poniżej, aby utworzyć listę filmów z kanału.</p>
            )}
            <button
              className="download-playlist-button"
              onClick={handleDownloadPlaylist}
              disabled={isDownloading || isSaving}
            >
              {isDownloading ? 'Pobieranie...' : listExists ? 'Aktualizuj playlistę' : 'Pobierz playlistę'}
            </button>
          </div>
        </div>
      )}

      {/* Videos list section - only visible when list.json exists */}
      {listExists === true && (
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
      )}
    </div>
  );
}

export default function StatusPage(): JSX.Element {
  const [state, dispatch] = useReducer(statusReducer, initialState);

  useEffect(() => {
    const fetchStatus = async () => {
      try {
        dispatch({ type: StatusActionType.FETCH_START });
        const response = await fetch('/api/status');
        if (!response.ok) {
          throw new Error('Failed to fetch status');
        }
        const data: StatusData = await response.json();
        dispatch({ type: StatusActionType.FETCH_SUCCESS, payload: data });
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'An error occurred';
        dispatch({ type: StatusActionType.FETCH_ERROR, payload: errorMessage });
      }
    };

    fetchStatus();
  }, []);

  const handleConfigUpdate = (folderPath: string, config: FolderConfig | null) => {
    if (state.statusData) {
      const updatedStatusData: StatusData = {
        ...state.statusData,
        folderConfigs: {
          ...state.statusData.folderConfigs,
          [folderPath]: config,
        },
      };
      dispatch({ type: StatusActionType.FETCH_SUCCESS, payload: updatedStatusData });
    }
  };

  return (
    <main className="app-main">
      <div className="status-page">
        
        {state.loading && (
          <div className="loading">
            <p>Ładowanie statusu...</p>
          </div>
        )}

        {state.error && (
          <div className="error-message">
            <p>Błąd: {state.error}</p>
          </div>
        )}

        {state.statusData && (() => {
          const statusData = state.statusData;
          return (
            <div className="status-content">
              <div className="status-section">
                <h2>Konfiguracja folderów wideo</h2>
                <div className="folder-sections">
                  {statusData.videosFolderPath.length > 0 ? (
                    statusData.videosFolderPath.map((path, index) => (
                      <FolderSection 
                        key={index} 
                        folderPath={path}
                        initialConfig={statusData.folderConfigs[path] || null}
                        onConfigUpdate={handleConfigUpdate}
                      />
                    ))
                  ) : (
                    <p>Brak skonfigurowanych ścieżek</p>
                  )}
                </div>
              </div>

              <div className="status-actions">
                <Link to="/videos" className="status-link">
                  Przejdź do listy filmów
                </Link>
              </div>
            </div>
          );
        })()}
      </div>
    </main>
  );
}

