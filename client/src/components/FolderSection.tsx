import type { FolderConfig } from '@videodeck/shared/api';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { VideoListSection } from './VideoListSection';

interface FolderSectionProps {
  folderPath: string;
  initialConfig: FolderConfig | null;
  /**
   * list.json presence from /api/status. The console only opens a row that has
   * one (a collection needs none), so anything but `true` shows no videos.
   */
  initialListExists?: boolean | null;
  /** A job was queued or cancelled in the video list; the console re-reads the queue */
  onQueueChanged?: () => void;
  /**
   * Bumped when a row action queued or cancelled work for this folder. The
   * video list's own poll is idle by then, so this is what makes it re-read.
   */
  queueRevision?: number;
}

/**
 * What the console shows under a channel row: the channel's videos, which load
 * with the row, and one line when the folder has no config.json. It renders as
 * a flat list of sections, not as a card of its own: the row above already
 * names the channel, shows the warnings and carries every action (the config
 * dialog and the playlist fetch included), so a second header, border or button
 * would only repeat them. A collection has no playlist, so its videos come from
 * the folder index instead.
 */
export function FolderSection({
  folderPath,
  initialConfig,
  initialListExists = null,
  onQueueChanged,
  queueRevision = 0,
}: FolderSectionProps) {
  const { t } = useTranslation();
  const isCollection = initialConfig?.kind === 'collection';

  // The video list hands this to its queue poll, so it keeps one identity no
  // matter how often the console re-renders the section
  const handleQueueChanged = useCallback(() => {
    onQueueChanged?.();
  }, [onQueueChanged]);

  return (
    <>
      {/* A folder with no config.json says so: editing one is a row-menu entry
          that opens a dialog, and this line is all the sheet itself knows */}
      {initialConfig === null && (
        <div className="folder-config">
          <div className="config-empty">
            <p>{t('config.missingFile')}</p>
          </div>
        </div>
      )}

      <VideoListSection
        folderPath={folderPath}
        listExists={isCollection || initialListExists === true}
        collection={isCollection}
        queueRevision={queueRevision}
        onQueueChanged={handleQueueChanged}
      />
    </>
  );
}
