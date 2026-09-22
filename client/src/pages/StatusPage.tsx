import type { QueueJob } from '@videodeck/shared/api';
import type { JSX } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChannelTable } from '../components/ChannelTable';
import type { ChannelFilterCounts } from '../components/ChannelToolbar';
import { ChannelToolbar } from '../components/ChannelToolbar';
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
import type { ChannelConsoleState } from '../utils/channelConsoleState';
import type { ChannelRow } from '../utils/channelTable';
import { buildChannelRows, filterChannels, foldersWithFinishedJobs, sortChannels } from '../utils/channelTable';
import { collectCategories } from '../utils/folderConfigForm';

/**
 * The download page as a console: one row per channel with its counts and what
 * the queue is doing with it, and the full folder section (config, playlist,
 * video list) under the row the URL expands. The page keeps its height whether
 * the library holds five channels or sixty.
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
  const { jobs, refresh: refreshQueue } = useChannelQueue();

  // A finished download changes the counts of its folder on disk. The queue
  // poll is what notices the job finishing, so compare each snapshot with the
  // previous one and re-read the folders that just lost an active job, and
  // only those: the full read costs two disk reads per configured folder.
  const previousJobsRef = useRef<readonly QueueJob[]>([]);
  useEffect(() => {
    const finishedFolders = foldersWithFinishedJobs(previousJobsRef.current, jobs);
    previousJobsRef.current = jobs;
    if (finishedFolders.length > 0) {
      void refreshFolderSummaries(finishedFolders);
    }
  }, [jobs, refreshFolderSummaries]);
  const { folders: channelsByFolder } = useChannelNames();
  const { pending, run } = useChannelActions({
    // A queue change can already have moved a video to "downloaded", and a
    // playlist fetch rewrites list.json: both refresh what the primary action
    // and the counts column read.
    onQueueChanged: () => {
      void refreshQueue();
      reloadSummaries();
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
  // The channel whose config form is open. The row menu opens it; collapsing
  // the row, saving or cancelling closes it again.
  const [editingFolder, setEditingFolder] = useState('');

  // The table header sticks below the queue bar, so the bar publishes its own
  // height: it wraps on narrower screens, and a hardcoded offset would leave
  // the header behind the bar or floating in the middle of the table.
  useStickyOffset(pageRef, queueBarRef, '--channel-queue-bar-height');

  const statusData = state.statusData;

  const rows = useMemo(
    () => (statusData ? buildChannelRows(statusData, summaries, jobs, channelsByFolder) : []),
    [statusData, summaries, jobs, channelsByFolder],
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

  /** Every console state change goes through here, so a collapsed row also
   *  closes the form it was showing. */
  const changeConsoleState = useCallback(
    (next: ChannelConsoleState): void => {
      if (next.folder !== consoleState.folder) {
        setEditingFolder('');
      }
      setConsoleState(next);
    },
    [consoleState.folder, setConsoleState],
  );

  const closeConfigEditor = useCallback((): void => {
    setEditingFolder('');
  }, []);

  const openConfigEditor = useCallback(
    (row: ChannelRow): void => {
      setConsoleState({ ...consoleState, folder: row.folderPath });
      setEditingFolder(row.folderPath);
    },
    [consoleState, setConsoleState],
  );

  return (
    <main className="app-main" ref={mainRef} tabIndex={-1}>
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
          (statusData.videosFolderPath.length === 0 ? (
            <p>{t('status.noFolders')}</p>
          ) : (
            <>
              <ChannelToolbar state={consoleState} counts={counts} onChange={changeConsoleState} />
              <ChannelTable
                rows={visibleRows}
                state={consoleState}
                onChange={changeConsoleState}
                countsLoading={summariesLoading}
                pending={pending}
                onAction={(row, action) => void run(row.folderPath, action)}
                onEditConfig={openConfigEditor}
                renderExpanded={(row) => (
                  <FolderSection
                    folderPath={row.folderPath}
                    initialConfig={statusData.folderConfigs[row.folderPath] || null}
                    downloadDefaults={statusData.downloadDefaults}
                    initialListExists={statusData.listExists[row.folderPath] ?? null}
                    knownCategories={knownCategories}
                    editingConfig={editingFolder === row.folderPath}
                    onEditingFinished={closeConfigEditor}
                    onConfigUpdate={updateFolderConfig}
                    onListChanged={() => {
                      reload();
                      void refreshFolderSummaries([row.folderPath]);
                    }}
                    onQueueChanged={refreshQueue}
                  />
                )}
              />
            </>
          ))}
      </div>
    </main>
  );
}
