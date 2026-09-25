import type { DownloadOptions, FolderConfig } from '@videodeck/shared/api';
import { ListExistsResponseSchema } from '@videodeck/shared/schemas';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet } from '../utils/apiClient';
import { FolderConfigEditor } from './FolderConfigEditor';
import { PlaylistDownloadSection } from './PlaylistDownloadSection';
import type { VideoListSectionHandle } from './VideoListSection';
import { VideoListSection } from './VideoListSection';

interface FolderSectionProps {
  folderPath: string;
  initialConfig: FolderConfig | null;
  downloadDefaults: DownloadOptions;
  /** list.json presence from /api/status; null = unknown (fall back to a fetch) */
  initialListExists?: boolean | null;
  /** Categories used by other folders, offered as input suggestions */
  knownCategories?: string[];
  /** Whether the config form is open; the console's row menu sets this */
  editingConfig: boolean;
  /** The form closed itself: the console drops its "editing" state */
  onEditingFinished: () => void;
  onConfigUpdate: (folderPath: string, config: FolderConfig | null) => void;
  /** A playlist fetch rewrote `list.json`; the console re-reads the counts */
  onListChanged?: () => void;
  /** A job was queued or cancelled in the video list; the console re-reads the queue */
  onQueueChanged?: () => void;
}

/**
 * What the console shows under a channel row: the config form, the playlist
 * actions and the channel's videos. It renders as a flat list of sections, not
 * as a card of its own: the row above already names the channel, shows the
 * warnings and carries the actions, so a second header and border would only
 * repeat them. A collection has no playlist, so it gets the form and its
 * videos, loaded as soon as the row opens.
 */
export function FolderSection({
  folderPath,
  initialConfig,
  downloadDefaults,
  initialListExists = null,
  knownCategories = [],
  editingConfig,
  onEditingFinished,
  onConfigUpdate,
  onListChanged,
  onQueueChanged,
}: FolderSectionProps) {
  const [listExists, setListExists] = useState<boolean | null>(initialListExists);
  const videoListSectionRef = useRef<VideoListSectionHandle>(null);

  // The config prop is the single source of truth (StatusPage holds it); the
  // editor reports saves through onConfigUpdate, which flows back down here.
  const hasChannelUrl = Boolean(initialConfig?.channelUrl);
  const isCollection = initialConfig?.kind === 'collection';

  // Reset the flag when the channel URL disappears from the config.
  if (!hasChannelUrl && listExists !== null) {
    setListExists(null);
  }

  const checkListExists = useCallback(async () => {
    try {
      const data = await apiGet(
        `/api/folder/list-exists?folderPath=${encodeURIComponent(folderPath)}`,
        ListExistsResponseSchema,
      );
      setListExists(data.exists);
    } catch {
      // Best-effort check: an unknown list.json state is handled by the parent
    }
  }, [folderPath]);

  // The batched /api/status value covers the initial render; a fetch is only
  // needed when it was unknown or after a playlist download created list.json.
  useEffect(() => {
    if (hasChannelUrl && initialListExists === null) {
      void checkListExists();
    }
  }, [hasChannelUrl, checkListExists, initialListExists]);

  // A channel waits for "load videos" because its list.json can hold
  // thousands of entries; a collection has no playlist step to wait for
  useEffect(() => {
    if (isCollection) {
      void videoListSectionRef.current?.loadVideos();
    }
  }, [isCollection]);

  const handleConfigUpdate = (folderPath: string, config: FolderConfig | null) => {
    onConfigUpdate(folderPath, config);
  };

  const handlePlaylistDownloaded = useCallback(() => {
    void checkListExists();
    onListChanged?.();
  }, [checkListExists, onListChanged]);

  const handleQueueChanged = useCallback(() => {
    onQueueChanged?.();
  }, [onQueueChanged]);

  return (
    <>
      <FolderConfigEditor
        folderPath={folderPath}
        initialConfig={initialConfig}
        downloadDefaults={downloadDefaults}
        knownCategories={knownCategories}
        editing={editingConfig}
        onEditingFinished={onEditingFinished}
        onConfigUpdate={handleConfigUpdate}
      />

      {!isCollection && (
        <PlaylistDownloadSection
          folderPath={folderPath}
          config={initialConfig}
          listExists={listExists}
          onPlaylistDownloaded={handlePlaylistDownloaded}
          onLoadVideosList={() => videoListSectionRef.current?.loadVideos()}
        />
      )}

      <VideoListSection
        ref={videoListSectionRef}
        folderPath={folderPath}
        listExists={isCollection || listExists === true}
        onQueueChanged={handleQueueChanged}
      />
    </>
  );
}
