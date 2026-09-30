import type { DownloadOptions, FolderConfig } from '@videodeck/shared/api';
import { useCallback } from 'react';
import { FolderConfigEditor } from './FolderConfigEditor';
import { VideoListSection } from './VideoListSection';

interface FolderSectionProps {
  folderPath: string;
  initialConfig: FolderConfig | null;
  downloadDefaults: DownloadOptions;
  /**
   * list.json presence from /api/status. The console only opens a row that has
   * one (a collection needs none), so anything but `true` shows no videos.
   */
  initialListExists?: boolean | null;
  /** Categories used by other folders, offered as input suggestions */
  knownCategories?: string[];
  /** Whether the config form is open; the console's row menu sets this */
  editingConfig: boolean;
  /** The form closed itself: the console drops its "editing" state */
  onEditingFinished: () => void;
  onConfigUpdate: (folderPath: string, config: FolderConfig | null) => void;
  /** A job was queued or cancelled in the video list; the console re-reads the queue */
  onQueueChanged?: () => void;
  /**
   * Bumped when a row action queued or cancelled work for this folder. The
   * video list's own poll is idle by then, so this is what makes it re-read.
   */
  queueRevision?: number;
}

/**
 * What the console shows under a channel row: the config form and the
 * channel's videos, which load with the row. It renders as a flat list of
 * sections, not as a card of its own: the row above already names the channel,
 * shows the warnings and carries every action (the playlist fetch included),
 * so a second header, border or button would only repeat them. A collection
 * has no playlist, so its videos come from the folder index instead.
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
  onQueueChanged,
  queueRevision = 0,
}: FolderSectionProps) {
  const isCollection = initialConfig?.kind === 'collection';

  // The video list hands this to its queue poll, so it keeps one identity no
  // matter how often the console re-renders the section
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
        onConfigUpdate={onConfigUpdate}
      />

      <VideoListSection
        folderPath={folderPath}
        listExists={isCollection || initialListExists === true}
        queueRevision={queueRevision}
        onQueueChanged={handleQueueChanged}
      />
    </>
  );
}
