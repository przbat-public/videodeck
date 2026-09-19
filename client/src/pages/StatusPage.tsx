import type { JSX } from 'react';
import { useMemo, useRef } from 'react';
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
import { useChannelQueue } from '../hooks/useChannelQueue';
import { useFolderSummaries } from '../hooks/useFolderSummaries';
import { usePageFocus } from '../hooks/usePageFocus';
import { useStatus } from '../hooks/useStatus';
import { useStickyOffset } from '../hooks/useStickyOffset';
import { buildChannelRows, filterChannels, sortChannels } from '../utils/channelTable';
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
  const { summaries, loading: summariesLoading, error: summariesError, reload: reloadSummaries } = useFolderSummaries();
  const { jobs, refresh: refreshQueue } = useChannelQueue();
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

  // The table header sticks below the queue bar, so the bar publishes its own
  // height: it wraps on narrower screens, and a hardcoded offset would leave
  // the header behind the bar or floating in the middle of the table.
  useStickyOffset(pageRef, queueBarRef, '--channel-queue-bar-height');

  const statusData = state.statusData;

  const rows = useMemo(
    () => (statusData ? buildChannelRows(statusData, summaries, jobs) : []),
    [statusData, summaries, jobs],
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
              <ChannelToolbar state={consoleState} counts={counts} onChange={setConsoleState} />
              <ChannelTable
                rows={visibleRows}
                state={consoleState}
                onChange={setConsoleState}
                countsLoading={summariesLoading}
                pending={pending}
                onAction={(row, action) => void run(row.folderPath, action)}
                renderExpanded={(row) => (
                  <FolderSection
                    folderPath={row.folderPath}
                    initialConfig={statusData.folderConfigs[row.folderPath] || null}
                    downloadDefaults={statusData.downloadDefaults}
                    indexed={statusData.indexedFolders.includes(row.folderPath)}
                    initialListExists={statusData.listExists[row.folderPath] ?? null}
                    knownCategories={knownCategories}
                    onConfigUpdate={updateFolderConfig}
                  />
                )}
              />
            </>
          ))}
      </div>
    </main>
  );
}
