import type { FolderSummary, QueueJob, StatusResponse } from '@videodeck/shared/api';

/**
 * Rows of the download page's channel console. Everything here is pure: the
 * page renders what these functions return, which keeps filtering, sorting and
 * the "needs attention" rule testable without a browser.
 */

/** What the row's filter chips select */
export type ChannelFilter = 'all' | 'attention' | 'queue' | 'failed';
/** How the table is ordered */
export type ChannelSort = 'name' | 'attention' | 'updated' | 'missing';

/**
 * Why a channel needs attention, in the order the row shows the reasons.
 * `noChannelUrl` comes first because nothing else can happen without it.
 */
export const ATTENTION_REASONS = ['noChannelUrl', 'noList', 'noIndex', 'failed', 'stale'] as const;
export type AttentionReason = (typeof ATTENTION_REASONS)[number];

export interface ChannelQueueCounts {
  running: number;
  queued: number;
  failed: number;
  /** Message of the first failed job, for the row's hint */
  firstError?: string;
}

export interface ChannelRow {
  folderPath: string;
  /** Last path segment: `/Volumes/MEDIA/youtube/kanal-04` shows as `kanal-04` */
  name: string;
  /**
   * The channel name the search index holds for this folder. The search
   * filters by `channelName`, so the "search in this channel" link needs this
   * and not the folder path; absent while the folder has no indexed videos.
   */
  channelName?: string;
  category?: string;
  /** Whether config.json carries a channelUrl */
  configured: boolean;
  /**
   * A folder of single downloads (`kind: "collection"`): no channel URL, no
   * list.json and no channel actions, its list comes from the folder index
   */
  collection: boolean;
  /** ES index present (true), missing (false) or unknown (null, cluster down) */
  indexed: boolean | null;
  /** `list.json` exists (false), does not (true) or is still unknown (null) */
  listExists: boolean | null;
  /** Counts from GET /api/folder/summaries; absent until they arrive */
  summary?: FolderSummary;
  queue: ChannelQueueCounts;
  attention: AttentionReason[];
}

/** Last path segment of a folder path, used as the channel's display name */
function folderName(folderPath: string): string {
  const trimmed = folderPath.replace(/[/\\]+$/, '');
  const separator = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return separator === -1 ? trimmed : trimmed.slice(separator + 1);
}

function isActive(job: QueueJob): boolean {
  return job.status === 'queued' || job.status === 'running';
}

/**
 * Folders whose job was active at the previous poll and is not any more: it
 * finished, failed, or was cancelled and swept. Their counts on disk may have
 * changed, so the console re-reads these folders and no other.
 */
export function foldersWithFinishedJobs(previous: readonly QueueJob[], current: readonly QueueJob[]): string[] {
  const stillActive = new Set(current.filter(isActive).map((job) => job.id));
  const folders = new Set<string>();
  for (const job of previous) {
    if (isActive(job) && !stillActive.has(job.id)) {
      folders.add(job.folderPath);
    }
  }
  return [...folders];
}

/** Group the queue's jobs by folder and count what each channel is doing */
function queueCountsByFolder(jobs: readonly QueueJob[]): Record<string, ChannelQueueCounts> {
  const byFolder: Record<string, ChannelQueueCounts> = {};
  for (const job of jobs) {
    let counts = byFolder[job.folderPath];
    if (counts === undefined) {
      counts = { running: 0, queued: 0, failed: 0 };
      byFolder[job.folderPath] = counts;
    }
    if (job.status === 'running') {
      counts.running += 1;
    } else if (job.status === 'queued') {
      counts.queued += 1;
    } else if (job.status === 'error') {
      counts.failed += 1;
      if (counts.firstError === undefined && job.error !== undefined) {
        counts.firstError = job.error;
      }
    }
  }
  return byFolder;
}

/**
 * The reasons this channel needs attention, in `ATTENTION_REASONS` order.
 * `indexed` is `null` while the status could not read Elasticsearch at all: the
 * console then reports no index state instead of chipping every channel, and
 * the banner above the table says why.
 */
function attentionReasons(row: Omit<ChannelRow, 'attention'>): AttentionReason[] {
  const reasons = new Set<AttentionReason>();
  if (!(row.configured || row.collection)) {
    reasons.add('noChannelUrl');
  }
  if (row.listExists === false && !row.collection) {
    reasons.add('noList');
  }
  if (row.indexed === false) {
    reasons.add('noIndex');
  }
  if (row.queue.failed > 0) {
    reasons.add('failed');
  }
  if ((row.summary?.stale ?? 0) > 0) {
    reasons.add('stale');
  }
  return ATTENTION_REASONS.filter((reason) => reasons.has(reason));
}

/** One row per configured folder, in the order /api/status reports them */
export function buildChannelRows(
  status: StatusResponse,
  summaries: Record<string, FolderSummary>,
  jobs: readonly QueueJob[],
  channelsByFolder: Record<string, string> = {},
): ChannelRow[] {
  const queueByFolder = queueCountsByFolder(jobs);

  return status.videosFolderPath.map((folderPath) => {
    const config = status.folderConfigs[folderPath] ?? null;
    const category = config?.category?.trim();
    const summary = summaries[folderPath];
    const channelName = channelsByFolder[folderPath];
    const base = {
      folderPath,
      name: folderName(folderPath),
      ...(channelName ? { channelName } : {}),
      ...(category ? { category } : {}),
      configured: Boolean(config?.channelUrl),
      collection: config?.kind === 'collection',
      indexed: status.elasticsearch === 'down' ? null : status.indexedFolders.includes(folderPath),
      listExists: status.listExists[folderPath] ?? null,
      ...(summary ? { summary } : {}),
      queue: queueByFolder[folderPath] ?? { running: 0, queued: 0, failed: 0 },
    };
    return { ...base, attention: attentionReasons(base) };
  });
}

/** Apply the text filter and the active chip */
export function filterChannels(
  rows: readonly ChannelRow[],
  options: { query: string; filter: ChannelFilter },
): ChannelRow[] {
  const needle = options.query.trim().toLowerCase();

  return rows.filter((row) => {
    if (needle.length > 0) {
      const haystack = `${row.name} ${row.folderPath} ${row.category ?? ''}`.toLowerCase();
      if (!haystack.includes(needle)) {
        return false;
      }
    }
    switch (options.filter) {
      case 'attention':
        return row.attention.length > 0;
      case 'queue':
        return row.queue.running + row.queue.queued > 0;
      case 'failed':
        return row.queue.failed > 0;
      default:
        return true;
    }
  });
}

/** Whenever two rows tie, the name decides, so the order is always stable */
function byName(a: ChannelRow, b: ChannelRow): number {
  return a.name.localeCompare(b.name, 'pl');
}

/** Newest update timestamp, or NaN for a channel that never updated */
function newestUpdate(row: ChannelRow): number {
  const newest = row.summary?.newestUpdate;
  return newest === undefined ? Number.NaN : Date.parse(newest);
}

export function sortChannels(rows: readonly ChannelRow[], sort: ChannelSort): ChannelRow[] {
  const sorted = [...rows];
  switch (sort) {
    case 'attention':
      return sorted.sort((a, b) => b.attention.length - a.attention.length || byName(a, b));
    case 'updated':
      return sorted.sort((a, b) => {
        const left = newestUpdate(a);
        const right = newestUpdate(b);
        if (Number.isNaN(left)) {
          return Number.isNaN(right) ? byName(a, b) : 1;
        }
        if (Number.isNaN(right)) {
          return -1;
        }
        return right - left || byName(a, b);
      });
    case 'missing':
      return sorted.sort((a, b) => (b.summary?.notDownloaded ?? 0) - (a.summary?.notDownloaded ?? 0) || byName(a, b));
    default:
      return sorted.sort(byName);
  }
}

/** Totals for the table's caption */
export function summarizeChannels(rows: readonly ChannelRow[]): {
  channels: number;
  videos: number;
  notDownloaded: number;
  needsAttention: number;
} {
  let videos = 0;
  let notDownloaded = 0;
  let needsAttention = 0;
  for (const row of rows) {
    videos += row.summary?.videos ?? 0;
    notDownloaded += row.summary?.notDownloaded ?? 0;
    if (row.attention.length > 0) {
      needsAttention += 1;
    }
  }
  return { channels: rows.length, videos, notDownloaded, needsAttention };
}
