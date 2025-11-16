import { useState } from 'react';
import { FolderConfig } from '../reducers/statusReducer';

interface PlaylistDownloadSectionProps {
  folderPath: string;
  config: FolderConfig | null;
  listExists: boolean | null;
  onPlaylistDownloaded: () => void;
  onLoadVideosList?: () => void;
}

export function PlaylistDownloadSection({ 
  folderPath, 
  config, 
  listExists,
  onPlaylistDownloaded,
  onLoadVideosList
}: PlaylistDownloadSectionProps) {
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

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

      // Notify parent to refresh list existence status
      onPlaylistDownloaded();
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'An error occurred';
      setDownloadError(errorMessage);
    } finally {
      setIsDownloading(false);
    }
  };

  if (!config || !config.channelUrl) {
    return null;
  }

  return (
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
        <div className="playlist-buttons">
          <button
            className="download-playlist-button"
            onClick={handleDownloadPlaylist}
            disabled={isDownloading}
          >
            {isDownloading ? 'Pobieranie...' : listExists ? 'Aktualizuj playlistę' : 'Pobierz playlistę'}
          </button>
          {listExists && onLoadVideosList && (
            <button
              className="load-videos-list-button"
              onClick={onLoadVideosList}
            >
              Pobierz listę filmów
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

