import type { FolderConfig } from '@videodeck/shared/api';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiSend } from '../utils/apiClient';
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
  const { t } = useTranslation();
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const handleDownloadPlaylist = async () => {
    if (!config?.channelUrl) {
      setDownloadError(t('playlist.noChannelUrl'));
      return;
    }

    try {
      setDownloadError(null);
      setIsDownloading(true);

      await apiSend(
        'POST',
        '/api/folder/download-playlist',
        null,
        { folderPath },
        {
          failureMessage: (failure) => failure.message ?? t('errors.downloadPlaylist'),
        },
      );

      // Notify parent to refresh list existence status
      onPlaylistDownloaded();
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : t('errors.occurred');
      setDownloadError(errorMessage);
    } finally {
      setIsDownloading(false);
    }
  };

  if (!config?.channelUrl) {
    return null;
  }

  return (
    <>
      {downloadError && <ErrorMessage compact>{t('app.error', { message: downloadError })}</ErrorMessage>}
      <div className="playlist-info">
        {listExists === null ? (
          <p>{t('playlist.checking')}</p>
        ) : listExists ? (
          <p>{t('playlist.exists')}</p>
        ) : (
          <p>{t('playlist.missing')}</p>
        )}
        <div className="playlist-buttons">
          <Button variant="primary" onClick={() => void handleDownloadPlaylist()} disabled={isDownloading}>
            {isDownloading ? t('playlist.downloading') : listExists ? t('playlist.update') : t('playlist.download')}
          </Button>
          {listExists && onLoadVideosList && <Button onClick={onLoadVideosList}>{t('playlist.loadVideos')}</Button>}
        </div>
      </div>
    </>
  );
}
