import type { JSX } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MAIN_CONTENT_ID } from '../components/AppLayout';
import { ChannelTable } from '../components/ChannelTable';
import type { ChannelFilterCounts } from '../components/ChannelToolbar';
import { ChannelToolbar } from '../components/ChannelToolbar';
import { FolderConfigEditor } from '../components/FolderConfigEditor';
import { FolderSection } from '../components/FolderSection';
import { QueueControls } from '../components/QueueControls';
import { Button } from '../components/ui/Button';
import { ErrorMessage } from '../components/ui/ErrorMessage';
import { Loading } from '../components/ui/Loading';
import { useChannelActions } from '../hooks/useChannelActions';
import { useChannelConsoleState } from '../hooks/useChannelConsoleState';
import { useChannelNames } from '../hooks/useChannelNames';
import { useChannelQueue } from '../hooks/useChannelQueue';
import { useFolderSummaries } from '../hooks/useFolderSummaries';
import { usePageFocus } from '../hooks/usePageFocus';
import { useStatus } from '../hooks/useStatus';
import { useStickyOffset } from '../hooks/useStickyOffset';
import type { ChannelQueueCounts, ChannelRow } from '../utils/channelTable';
import { buildChannelRows, filterChannels, foldersWithFinishedJobs, sortChannels } from '../utils/channelTable';
import { collectCategories } from '../utils/folderConfigForm';

/** The open config dialog: which folder it edits, and what takes focus back */
interface EditingConfig {
  folderPath: string;
  returnFocus: HTMLButtonElement | null;
}

/**
 * The download page as a console: one row per channel with its counts and what
 * the queue is doing with it, and the folder section (video list) under the row
 * the URL expands. The page keeps its height whether the library holds five
 * channels or sixty. Editing a config.json is a modal dialog of its own, so the
 * row menu entry never moves the list under the reader.
 */
export default function StatusPage(): JSX.Element {
  const { state, updateFolderConfig, reload } = useStatus();
  const { state: consoleState, setState: setConsoleState } = useChannelConsoleState();
  const {
    summaries,
    loading: summariesLoading,
    error: summariesError,
    reload: reloadSummaries,
    refreshFolders: refreshFolderSummaries,
  } = useFolderSummaries();
  const { queueByFolder, refresh: refreshQueue } = useChannelQueue();

  // A finished download changes the counts of its folder on disk. The queue
  // summary is what notices the job finishing, so compare each snapshot with
  // the previous one and re-read the folders that just lost active work, and
  // only those: the full read costs two disk reads per configured folder.
  const previousQueueRef = useRef<Record<string, ChannelQueueCounts>>({});
  useEffect(() => {
    const finishedFolders = foldersWithFinishedJobs(previousQueueRef.current, queueByFolder);
    previousQueueRef.current = queueByFolder;
    if (finishedFolders.length > 0) {
      void refreshFolderSummaries(finishedFolders);
    }
  }, [queueByFolder, refreshFolderSummaries]);
  const { folders: channelsByFolder } = useChannelNames();
  // What the row actions changed, per folder, as a counter the open section
  // watches. The video list polls its own folder queue only while it sees
  // active jobs, so an idle section has to be told when work arrives from
  // outside it (a bulk action in the row's menu).
  const [queueRevisions, setQueueRevisions] = useState<Record<string, number>>({});
  const bumpQueueRevision = useCallback((folderPath: string): void => {
    setQueueRevisions((previous) => ({ ...previous, [folderPath]: (previous[folderPath] ?? 0) + 1 }));
  }, []);
  const { pending, run } = useChannelActions({
    // A queue change can already have moved a video to "downloaded", and a
    // playlist fetch rewrites list.json: both refresh what the primary action
    // and the counts column read.
    onQueueChanged: (folderPath) => {
      void refreshQueue();
      reloadSummaries();
      bumpQueueRevision(folderPath);
    },
    onListChanged: () => {
      reload();
      reloadSummaries();
    },
  });
  const { t } = useTranslation();
  const mainRef = usePageFocus<HTMLElement>();
  const pageRef = useRef<HTMLDivElement>(null);
  const queueBarRef = useRef<HTMLDivElement>(null);
  // The config dialog the row menu opened, if any. Saving, cancelling or
  // Escape closes it; the row it belongs to stays exactly as it was.
  const [editingConfig, setEditingConfig] = useState<EditingConfig | null>(null);

  // The table header sticks below the queue bar, so the bar publishes its own
  // height: it wraps on narrower screens, and a hardcoded offset would leave
  // the header behind the bar or floating in the middle of the table.
  useStickyOffset(pageRef, queueBarRef, '--channel-queue-bar-height');

  const statusData = state.statusData;

  const rows = useMemo(
    () => (statusData ? buildChannelRows(statusData, summaries, queueByFolder, channelsByFolder) : []),
    [statusData, summaries, queueByFolder, channelsByFolder],
  );

  const visibleRows = useMemo(
    () => sortChannels(filterChannels(rows, consoleState), consoleState.sort),
    [rows, consoleState],
  );

  // Chip counts come from every row, not the filtered ones: a chip that reads
  // "(0)" would look broken while its own filter is the reason it is empty.
  const counts: ChannelFilterCounts = useMemo(
    () => ({
      all: rows.length,
      attention: rows.filter((row) => row.attention.length > 0).length,
      queue: rows.filter((row) => row.queue.running + row.queue.queued > 0).length,
      failed: rows.filter((row) => row.queue.failed > 0).length,
    }),
    [rows],
  );

  const knownCategories = statusData ? collectCategories(statusData.folderConfigs) : [];

  const closeConfigEditor = useCallback((): void => {
    setEditingConfig(null);
  }, []);

  // No row to expand: the dialog stands on its own, which is the point of it
  // (the entry used to open the video list as a side effect, and hiding that
  // list again was the reader's problem).
  const openConfigEditor = useCallback((row: ChannelRow, returnFocus: HTMLButtonElement | null): void => {
    setEditingConfig({ folderPath: row.folderPath, returnFocus });
  }, []);

  return (
    <main id={MAIN_CONTENT_ID} className="app-main" ref={mainRef} tabIndex={-1}>
      {/* React 19 hoists the title into <head> */}
      <title>{t('pageTitle.channels')}</title>
      <div className="status-page" ref={pageRef}>
        <h1>{t('channelConsole.title')}</h1>

        <div className="channel-queue-bar" ref={queueBarRef}>
          <QueueControls />
        </div>

        {state.loading && <Loading message={t('status.loading')} />}

        {state.error && (
          <div className="page-error">
            <ErrorMessage>{t('app.error', { message: state.error })}</ErrorMessage>
            <Button onClick={reload}>{t('app.retry')}</Button>
          </div>
        )}

        {summariesError && (
          <ErrorMessage compact>{t('channelConsole.countsError', { message: summariesError })}</ErrorMessage>
        )}

        {statusData &&
          (statusData.videosFolderPath.length === 0 && statusData.unavailableFolders.length === 0 ? (
            <p>{t('status.noFolders')}</p>
          ) : (
            <>
              {/* No folder is on disk, but the library remembers some: the
                  drives are unplugged, which is not a config problem */}
              {statusData.videosFolderPath.length === 0 && <p>{t('status.drivesUnplugged')}</p>}
              <ChannelToolbar state={consoleState} counts={counts} onChange={setConsoleState} />
              <ChannelTable
                rows={visibleRows}
                state={consoleState}
                onChange={setConsoleState}
                countsLoading={summariesLoading}
                pending={pending}
                onAction={(row, action) => void run(row.folderPath, action)}
                onEditConfig={openConfigEditor}
                renderExpanded={(row) => (
                  <FolderSection
                    folderPath={row.folderPath}
                    initialConfig={statusData.folderConfigs[row.folderPath] || null}
                    initialListExists={statusData.listExists[row.folderPath] ?? null}
                    queueRevision={queueRevisions[row.folderPath] ?? 0}
                    onQueueChanged={refreshQueue}
                  />
                )}
              />
              {/* The config dialog sits beside the table, not inside the
                  expanded row: it opens without the row, and the row it names
                  keeps rendering whatever list it was showing */}
              {editingConfig !== null && (
                <FolderConfigEditor
                  folderPath={editingConfig.folderPath}
                  initialConfig={statusData.folderConfigs[editingConfig.folderPath] ?? null}
                  downloadDefaults={statusData.downloadDefaults}
                  knownCategories={knownCategories}
                  returnFocus={editingConfig.returnFocus}
                  onClose={closeConfigEditor}
                  onConfigUpdate={updateFolderConfig}
                />
              )}
            </>
          ))}
      </div>
    </main>
  );
}
