import { Ellipsis } from 'lucide-react';
import { Fragment, type JSX, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import type { ChannelAction } from '../hooks/useChannelActions';
import type { ChannelConsoleState } from '../utils/channelConsoleState';
import type { AttentionReason, ChannelRow } from '../utils/channelTable';
import { summarizeChannels } from '../utils/channelTable';
import { Button } from './ui/Button';
import { Menu, MenuContent, MenuItem, MenuLinkItem, MenuSeparator, MenuTrigger } from './ui/Menu';

interface ChannelTableProps {
  rows: ChannelRow[];
  state: ChannelConsoleState;
  onChange: (next: ChannelConsoleState) => void;
  /** Content of the row the URL has expanded; the page hands it a FolderSection */
  renderExpanded: (row: ChannelRow) => ReactNode;
  /** True while the counts are still on their way */
  countsLoading: boolean;
  /** Folder path to the queue action it is running, for the row's busy state */
  pending: Record<string, ChannelAction>;
  /** Starts one of the row's queue actions; the page owns the fetch */
  onAction: (row: ChannelRow, action: ChannelAction) => void;
  /** Opens the config editor for the row (the page expands it and edits) */
  onEditConfig: (row: ChannelRow) => void;
}

/**
 * The reasons shown as chips in the channel cell. The others already have a
 * home: the stale counts sit in the video column and the failed jobs in the
 * queue column, so a chip would only repeat them. A missing `list.json` shows
 * as a zero count plus the "fetch the playlist" action.
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
      <span className="channel-count">{t('channelConsole.videos.total', { count: summary.videos })}</span>
      {summary.notDownloaded > 0 && (
        <span className="channel-count channel-count--warn">
          {t('channelConsole.videos.notDownloaded', { count: summary.notDownloaded })}
        </span>
      )}
      {summary.stale > 0 && (
        <span className="channel-count channel-count--warn">
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

interface ChannelActionsCellProps {
  row: ChannelRow;
  expanded: boolean;
  pendingAction: ChannelAction | undefined;
  onToggle: (row: ChannelRow) => void;
  onAction: (row: ChannelRow, action: ChannelAction) => void;
  onEditConfig: (row: ChannelRow) => void;
}

interface ChannelRowMenuProps {
  row: ChannelRow;
  busy: boolean;
  onAction: (row: ChannelRow, action: ChannelAction) => void;
  onEditConfig: (row: ChannelRow) => void;
}

/**
 * The row's queue actions behind the ⋯ trigger: what can be bulk-done with the
 * channel, cancelling its jobs, the config form and the search link. Every one
 * of them lives here, so the row never repeats an action as a button.
 */
function ChannelRowMenu({ row, busy, onAction, onEditConfig }: ChannelRowMenuProps): JSX.Element {
  const { t } = useTranslation();
  const { summary, queue } = row;
  // Counts arrive after the table and may never arrive at all. They only
  // decide what looks pointless; the actions themselves read list.json, which
  // is the authority, so an unknown count disables nothing.
  const countsKnown = summary !== undefined;
  const activeJobs = queue.running + queue.queued;

  return (
    <Menu>
      <MenuTrigger aria-label={t('channelConsole.actions.more')}>
        <Ellipsis aria-hidden="true" focusable="false" className="channel-menu-icon" />
      </MenuTrigger>
      <MenuContent>
        {row.listExists === false ? (
          <>
            {/* Without list.json there is nothing to update or download, so
                the playlist is the only bulk entry on offer. Without a
                channel URL there is not even that. */}
            <MenuItem disabled={busy || !row.configured} onSelect={() => onAction(row, 'playlist')}>
              {t('channelConsole.actions.downloadPlaylist')}
            </MenuItem>
            <MenuSeparator />
          </>
        ) : (
          <>
            <MenuItem
              disabled={busy || (countsKnown && (summary?.stale ?? 0) === 0)}
              onSelect={() => onAction(row, 'update-stale')}
            >
              {t('channelConsole.actions.updateStale')}
            </MenuItem>
            <MenuItem
              disabled={busy || (countsKnown && (summary?.downloaded ?? 0) === 0)}
              onSelect={() => onAction(row, 'update')}
            >
              {t('channelConsole.actions.updateAll')}
            </MenuItem>
            <MenuItem
              disabled={busy || (countsKnown && summary?.notDownloaded === 0)}
              onSelect={() => onAction(row, 'download')}
            >
              {t('channelConsole.actions.downloadAll')}
            </MenuItem>
            <MenuSeparator />
          </>
        )}
        <MenuItem disabled={busy || activeJobs === 0} onSelect={() => onAction(row, 'cancel')}>
          {t('channelConsole.actions.cancel')}
        </MenuItem>
        <MenuItem onSelect={() => onEditConfig(row)}>{t('channelConsole.actions.editConfig')}</MenuItem>
        {/* The search filters by channel name, so a folder whose videos are
            not indexed yet has nothing to link to */}
        {row.channelName !== undefined && row.channelName !== '' && (
          <MenuLinkItem>
            <Link to={`/?channel=${encodeURIComponent(row.channelName)}`}>{t('channelConsole.searchInChannel')}</Link>
          </MenuLinkItem>
        )}
      </MenuContent>
    </Menu>
  );
}

/**
 * The row's actions: the expand toggle and the ⋯ menu. Every queue action
 * lives in the menu, so a row never repeats one of them as a button and the
 * three controls that used to crowd the column are gone.
 */
function ChannelActionsCell({
  row,
  expanded,
  pendingAction,
  onToggle,
  onAction,
  onEditConfig,
}: ChannelActionsCellProps): JSX.Element {
  const { t } = useTranslation();
  const busy = pendingAction !== undefined;

  return (
    <td data-label={t('channelConsole.column.actions')} aria-busy={busy}>
      <span className="channel-actions">
        <Button size="small" onClick={() => onToggle(row)}>
          {expanded ? t('channelConsole.collapse') : t('channelConsole.expand')}
        </Button>
        <ChannelRowMenu row={row} busy={busy} onAction={onAction} onEditConfig={onEditConfig} />
        {busy && <span className="channel-badge channel-badge--info">{t('channelConsole.actions.working')}</span>}
      </span>
    </td>
  );
}

interface ChannelRowItemProps {
  row: ChannelRow;
  expanded: boolean;
  countsLoading: boolean;
  pendingAction: ChannelAction | undefined;
  onToggle: (row: ChannelRow) => void;
  onAction: (row: ChannelRow, action: ChannelAction) => void;
  onEditConfig: (row: ChannelRow) => void;
  renderExpanded: (row: ChannelRow) => ReactNode;
}

/** One channel: its cells, and the expanded section underneath when open */
function ChannelRowItem({
  row,
  expanded,
  countsLoading,
  pendingAction,
  onToggle,
  onAction,
  onEditConfig,
  renderExpanded,
}: ChannelRowItemProps): JSX.Element {
  const { t } = useTranslation();
  const { summary } = row;
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

        <td data-label={t('channelConsole.column.videos')}>
          <ChannelVideosCell summary={summary} countsLoading={countsLoading} />
        </td>

        <td data-label={t('channelConsole.column.queue')}>
          <ChannelQueueCell queue={row.queue} />
        </td>

        <ChannelActionsCell
          row={row}
          expanded={expanded}
          pendingAction={pendingAction}
          onToggle={onToggle}
          onAction={onAction}
          onEditConfig={onEditConfig}
        />
      </tr>
      {expanded && (
        <tr className="channel-expanded-row">
          <td colSpan={4}>{renderExpanded(row)}</td>
        </tr>
      )}
    </Fragment>
  );
}

/**
 * The channel console's table: one row per channel with its counts and what
 * the queue is doing with it. The row the URL names is expanded underneath,
 * where the page renders the config form, the playlist actions and the video
 * list, so nothing the old stacked sections had is lost.
 */
export function ChannelTable({
  rows,
  state,
  onChange,
  renderExpanded,
  countsLoading,
  pending,
  onAction,
  onEditConfig,
}: ChannelTableProps): JSX.Element {
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
              pendingAction={pending[row.folderPath]}
              onToggle={toggleRow}
              onAction={onAction}
              onEditConfig={onEditConfig}
              renderExpanded={renderExpanded}
            />
          ))}
        </tbody>
      </table>

      {rows.length === 0 && <p className="channel-empty">{t('channelConsole.empty')}</p>}
    </div>
  );
}
