import { useState } from 'react';
import type { ApiError, FolderConfig } from '@shared/api';
import { Button } from './ui/Button';
import { ErrorMessage } from './ui/ErrorMessage';

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
  onLoadVideosList,
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
        const errorData: ApiError = await response.json();
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
      {downloadError && <ErrorMessage compact>Błąd: {downloadError}</ErrorMessage>}
      <div className="playlist-info">
        {listExists === null ? (
          <p>Sprawdzanie statusu pliku list.json...</p>
        ) : listExists ? (
          <p>
            Plik list.json już istnieje. Kliknij przycisk poniżej, aby zaktualizować listę filmów.
          </p>
        ) : (
          <p>
            Plik list.json nie istnieje. Kliknij przycisk poniżej, aby utworzyć listę filmów z
            kanału.
          </p>
        )}
        <div className="playlist-buttons">
          <Button
            variant="primary"
            onClick={() => void handleDownloadPlaylist()}
            disabled={isDownloading}
          >
            {isDownloading
              ? 'Pobieranie...'
              : listExists
                ? 'Aktualizuj playlistę'
                : 'Pobierz playlistę'}
          </Button>
          {listExists && onLoadVideosList && (
            <Button onClick={onLoadVideosList}>Pobierz listę filmów</Button>
          )}
        </div>
      </div>
    </div>
  );
}
