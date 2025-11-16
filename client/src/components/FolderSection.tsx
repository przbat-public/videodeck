import { useState, useEffect, useRef } from 'react';
import { FolderConfig } from '../reducers/statusReducer';
import { FolderConfigEditor } from './FolderConfigEditor';
import { PlaylistDownloadSection } from './PlaylistDownloadSection';
import { VideoListSection, VideoListSectionHandle } from './VideoListSection';

interface FolderSectionProps {
  folderPath: string;
  initialConfig: FolderConfig | null;
  onConfigUpdate: (folderPath: string, config: FolderConfig | null) => void;
}

export function FolderSection({ folderPath, initialConfig, onConfigUpdate }: FolderSectionProps) {
  const [config, setConfig] = useState<FolderConfig | null>(initialConfig);
  const [listExists, setListExists] = useState<boolean | null>(null);
  const videoListSectionRef = useRef<VideoListSectionHandle>(null);

  // Update local state when initialConfig changes
  useEffect(() => {
    setConfig(initialConfig);
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

  const handleConfigUpdate = (folderPath: string, config: FolderConfig | null) => {
    setConfig(config);
    onConfigUpdate(folderPath, config);
  };

  const handlePlaylistDownloaded = async () => {
    // Refresh list existence status after playlist download
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

  return (
    <div className="folder-section">
      <div className="folder-section-header">
        <h3 className="folder-path">{folderPath}</h3>
      </div>
      
      <FolderConfigEditor
        folderPath={folderPath}
        initialConfig={config}
        onConfigUpdate={handleConfigUpdate}
      />

      <PlaylistDownloadSection
        folderPath={folderPath}
        config={config}
        listExists={listExists}
        onPlaylistDownloaded={handlePlaylistDownloaded}
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

