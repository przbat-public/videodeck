import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { DownloadOptions, FolderConfig, ListExistsResponse } from '@shared/api';
import { FolderConfigEditor } from './FolderConfigEditor';
import { PlaylistDownloadSection } from './PlaylistDownloadSection';
import type { VideoListSectionHandle } from './VideoListSection';
import { VideoListSection } from './VideoListSection';

interface FolderSectionProps {
  folderPath: string;
  initialConfig: FolderConfig | null;
  downloadDefaults: DownloadOptions;
  /** Whether this folder already has a search cache in Elasticsearch */
  indexed: boolean;
  /** list.json presence from /api/status; null = unknown (fall back to a fetch) */
  initialListExists?: boolean | null;
  /** Categories used by other folders, offered as input suggestions */
  knownCategories?: string[];
  onConfigUpdate: (folderPath: string, config: FolderConfig | null) => void;
}

export function FolderSection({
  folderPath,
  initialConfig,
  downloadDefaults,
  indexed,
  initialListExists = null,
  knownCategories = [],
  onConfigUpdate,
}: FolderSectionProps) {
  const [listExists, setListExists] = useState<boolean | null>(initialListExists);
  const { t } = useTranslation();
  const videoListSectionRef = useRef<VideoListSectionHandle>(null);

  // The config prop is the single source of truth (StatusPage holds it); the
  // editor reports saves through onConfigUpdate, which flows back down here.
  const hasChannelUrl = Boolean(initialConfig?.channelUrl);

  // Reset the flag when the channel URL disappears from the config.
  if (!hasChannelUrl && listExists !== null) {
    setListExists(null);
  }

  const checkListExists = useCallback(async () => {
    try {
      const response = await fetch(
        `/api/folder/list-exists?folderPath=${encodeURIComponent(folderPath)}`
      );
      if (response.ok) {
        const data: ListExistsResponse = await response.json();
        setListExists(data.exists);
      }
    } catch (err) {
      console.error('Error checking list.json:', err);
    }
  }, [folderPath]);

  // The batched /api/status value covers the initial render; a fetch is only
  // needed when it was unknown or after a playlist download created list.json.
  useEffect(() => {
    if (hasChannelUrl && initialListExists === null) {
      void checkListExists();
    }
  }, [hasChannelUrl, checkListExists, initialListExists]);

  const handleConfigUpdate = (folderPath: string, config: FolderConfig | null) => {
    onConfigUpdate(folderPath, config);
  };

  return (
    <div className="folder-section">
      <div className="folder-section-header">
        <h3 className="folder-path">{folderPath}</h3>
        {/* Only the actionable state is shown: a missing ES index needs the
            "refresh index (missing only)" run; "ready" adds nothing. */}
        {!indexed && (
          <span className="folder-index-badge" title={t('status.indexMissingTitle')}>
            {t('status.indexMissing')}
          </span>
        )}
      </div>

      <FolderConfigEditor
        folderPath={folderPath}
        initialConfig={initialConfig}
        downloadDefaults={downloadDefaults}
        knownCategories={knownCategories}
        onConfigUpdate={handleConfigUpdate}
      />

      <PlaylistDownloadSection
        folderPath={folderPath}
        config={initialConfig}
        listExists={listExists}
        onPlaylistDownloaded={checkListExists}
        onLoadVideosList={() => videoListSectionRef.current?.loadVideos()}
      />

      <VideoListSection
        ref={videoListSectionRef}
        folderPath={folderPath}
        listExists={listExists === true}
      />
    </div>
  );
}
