import { Fragment, type JSX, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChannelConsoleState } from '../utils/channelConsoleState';
import type { AttentionReason, ChannelRow } from '../utils/channelTable';
import { summarizeChannels } from '../utils/channelTable';
import { formatAge } from '../utils/videoDates';

interface ChannelTableProps {
  rows: ChannelRow[];
  state: ChannelConsoleState;
  onChange: (next: ChannelConsoleState) => void;
  /** Content of the row the URL has expanded; the page hands it a FolderSection */
  renderExpanded: (row: ChannelRow) => ReactNode;
  /** True while the counts are still on their way */
  countsLoading: boolean;
}

/**
 * The reasons shown as chips in the channel cell. The others are already
 * visible in their own column: the playlist state, the stale counts and the
 * failed jobs each have one, and a chip would only repeat them.
 */
const CHANNEL_CELL_REASONS: readonly AttentionReason[] = ['noChannelUrl', 'noIndex'];

type AttentionLabelKey =
  | 'channelConsole.attention.noChannelUrl'
  | 'channelConsole.attention.noList'
  | 'channelConsole.attention.noIndex'
  | 'channelConsole.attention.failed'
  | 'channelConsole.attention.stale';

/** i18n key of every "needs attention" chip */
const ATTENTION_LABEL_KEYS: Record<AttentionReason, AttentionLabelKey> = {
  noChannelUrl: 'channelConsole.attention.noChannelUrl',
  noList: 'channelConsole.attention.noList',
  noIndex: 'channelConsole.attention.noIndex',
  failed: 'channelConsole.attention.failed',
  stale: 'channelConsole.attention.stale',
};

interface ChannelVideosCellProps {
  summary: ChannelRow['summary'];
  countsLoading: boolean;
}

/** How many videos the channel has, how many are missing and how many are old */
function ChannelVideosCell({ summary, countsLoading }: ChannelVideosCellProps): JSX.Element {
  const { t } = useTranslation();
  if (summary === undefined) {
    return <span className="channel-muted">{countsLoading ? t('channelConsole.videos.loading') : '—'}</span>;
  }
  return (
    <>
      <span>{t('channelConsole.videos.total', { count: summary.videos })}</span>
      {summary.notDownloaded > 0 && (
        <span className="channel-badge channel-badge--warn">
          {t('channelConsole.videos.notDownloaded', { count: summary.notDownloaded })}
        </span>
      )}
      {summary.stale > 0 && (
        <span className="channel-badge channel-badge--warn">
          {t('channelConsole.videos.stale', { count: summary.stale })}
        </span>
      )}
    </>
  );
}

/** What the queue is doing with this channel right now */
function ChannelQueueCell({ queue }: { queue: ChannelRow['queue'] }): JSX.Element {
  const { t } = useTranslation();
  if (queue.running + queue.queued + queue.failed === 0) {
    return <span className="channel-muted">—</span>;
  }
  return (
    <span className="channel-badges">
      {queue.running > 0 && (
        <span className="channel-badge channel-badge--info">
          {t('channelConsole.queue.running', { count: queue.running })}
        </span>
      )}
      {queue.queued > 0 && (
        <span className="channel-badge">{t('channelConsole.queue.queued', { count: queue.queued })}</span>
      )}
      {queue.failed > 0 && (
        <span className="channel-badge channel-badge--bad">
          {t('channelConsole.queue.failed', { count: queue.failed })}
        </span>
      )}
    </span>
  );
}

interface ChannelRowItemProps {
  row: ChannelRow;
  expanded: boolean;
  countsLoading: boolean;
  onToggle: (row: ChannelRow) => void;
  renderExpanded: (row: ChannelRow) => ReactNode;
}

/** One channel: its cells, and the expanded section underneath when open */
function ChannelRowItem({ row, expanded, countsLoading, onToggle, renderExpanded }: ChannelRowItemProps): JSX.Element {
  const { t, i18n } = useTranslation();
  const { summary, queue } = row;
  const cellReasons = row.attention.filter((reason) => CHANNEL_CELL_REASONS.includes(reason));

  return (
    <Fragment key={row.folderPath}>
      <tr className={expanded ? 'channel-row channel-row--expanded' : 'channel-row'}>
        <td data-label={t('channelConsole.column.channel')}>
          <span className="channel-name">{row.name}</span>
          <span className="channel-path">{row.folderPath}</span>
          {cellReasons.length > 0 && (
            <span className="channel-badges">
              {cellReasons.map((reason) => (
                <span key={reason} className="channel-badge channel-badge--warn">
                  {t(ATTENTION_LABEL_KEYS[reason])}
                </span>
              ))}
            </span>
          )}
        </td>

        <td data-label={t('channelConsole.column.playlist')}>
          {row.listExists === null ? (
            <span className="channel-muted">{t('channelConsole.list.checking')}</span>
          ) : row.listExists ? (
            <>
              <span>{t('channelConsole.list.exists')}</span>
              {summary?.newestUpdate !== undefined && summary.newestUpdate !== '' && (
                <span className="channel-muted channel-age">{formatAge(summary.newestUpdate, i18n.language)}</span>
              )}
            </>
          ) : (
            <span className="channel-badge channel-badge--warn">{t('channelConsole.list.missing')}</span>
          )}
        </td>

        <td data-label={t('channelConsole.column.videos')}>
          <ChannelVideosCell summary={summary} countsLoading={countsLoading} />
        </td>

        <td data-label={t('channelConsole.column.queue')}>
          <ChannelQueueCell queue={queue} />
        </td>

        <td data-label={t('channelConsole.column.actions')}>
          <span className="channel-actions">
            <button type="button" className="channel-expand" onClick={() => onToggle(row)}>
              {expanded ? t('channelConsole.collapse') : t('channelConsole.expand')}
            </button>
            <a className="channel-search-link" href={`/?channel=${encodeURIComponent(row.folderPath)}`}>
              {t('channelConsole.searchInChannel')}
            </a>
          </span>
        </td>
      </tr>
      {expanded && (
        <tr className="channel-expanded-row">
          <td colSpan={5}>{renderExpanded(row)}</td>
        </tr>
      )}
    </Fragment>
  );
}

/**
 * The channel console's table: one row per channel with its playlist state,
 * its counts and what the queue is doing with it. The row the URL names is
 * expanded underneath, where the page renders the full folder section, so
 * nothing that used to be on this page is lost.
 */
export function ChannelTable({ rows, state, onChange, renderExpanded, countsLoading }: ChannelTableProps): JSX.Element {
  const { t } = useTranslation();
  const totals = summarizeChannels(rows);

  const toggleRow = (row: ChannelRow): void => {
    onChange({ ...state, folder: state.folder === row.folderPath ? '' : row.folderPath });
  };

  return (
    <div className="channel-table-card">
      <table className="channel-table">
        <caption className="channel-caption">
          {t('channelConsole.summary', {
            channels: totals.channels,
            videos: totals.videos,
            missing: totals.notDownloaded,
            attention: totals.needsAttention,
          })}
        </caption>
        <thead>
          <tr>
            <th scope="col" aria-sort={state.sort === 'name' ? 'ascending' : 'none'}>
              <button
                type="button"
                className="channel-sort-header"
                onClick={() => onChange({ ...state, sort: 'name' })}
              >
                {t('channelConsole.column.channel')}
              </button>
            </th>
            <th scope="col">{t('channelConsole.column.playlist')}</th>
            <th scope="col">{t('channelConsole.column.videos')}</th>
            <th scope="col">{t('channelConsole.column.queue')}</th>
            <th scope="col">{t('channelConsole.column.actions')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <ChannelRowItem
              key={row.folderPath}
              row={row}
              expanded={state.folder === row.folderPath}
              countsLoading={countsLoading}
              onToggle={toggleRow}
              renderExpanded={renderExpanded}
            />
          ))}
        </tbody>
      </table>

      {rows.length === 0 && <p className="channel-empty">{t('channelConsole.empty')}</p>}
    </div>
  );
}
