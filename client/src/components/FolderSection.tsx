import { useState, useEffect, useRef, useCallback } from 'react';
import type { DownloadOptions, FolderConfig, ListExistsResponse } from '@shared/api';
import { FolderConfigEditor } from './FolderConfigEditor';
import { PlaylistDownloadSection } from './PlaylistDownloadSection';
import type { VideoListSectionHandle } from './VideoListSection';
import { VideoListSection } from './VideoListSection';

interface FolderSectionProps {
  folderPath: string;
  initialConfig: FolderConfig | null;
  downloadDefaults: DownloadOptions;
  /** Categories used by other folders, offered as input suggestions */
  knownCategories?: string[];
  onConfigUpdate: (folderPath: string, config: FolderConfig | null) => void;
}

export function FolderSection({
  folderPath,
  initialConfig,
  downloadDefaults,
  knownCategories = [],
  onConfigUpdate,
}: FolderSectionProps) {
  const [listExists, setListExists] = useState<boolean | null>(null);
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

  // Check list.json once the channel URL becomes configured
  useEffect(() => {
    if (hasChannelUrl) {
      void checkListExists();
    }
  }, [hasChannelUrl, checkListExists]);

  const handleConfigUpdate = (folderPath: string, config: FolderConfig | null) => {
    onConfigUpdate(folderPath, config);
  };

  return (
    <div className="folder-section">
      <div className="folder-section-header">
        <h3 className="folder-path">{folderPath}</h3>
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
