import type { ChannelVideo, FolderSummary } from '@videodeck/shared/api';
import { isUpdateStale } from '@videodeck/shared/dates';

/** What the folder index knows about a folder's videos */
export interface FolderIndexStatuses {
  downloadStatuses: Record<string, boolean>;
  lastUpdatedDates: Record<string, string>;
}

const EMPTY_SUMMARY: FolderSummary = { videos: 0, downloaded: 0, notDownloaded: 0, stale: 0 };

/**
 * Count what the console shows for one channel: how many playlist videos are
 * downloaded, how many are missing, how many downloads are stale and when the
 * folder was last touched.
 *
 * Only videos that `list.json` still contains are counted. The folder index
 * keeps entries for videos removed from the channel, and letting those reach
 * the counts would report more downloads than videos.
 */
export function summarizeFolder(
  list: readonly ChannelVideo[] | null,
  statuses: FolderIndexStatuses,
  now: number = Date.now(),
): FolderSummary {
  if (list === null || list.length === 0) {
    return { ...EMPTY_SUMMARY };
  }

  let downloaded = 0;
  let stale = 0;
  let newest = Number.NaN;

  for (const video of list) {
    if (statuses.downloadStatuses[video.id] !== true) {
      continue;
    }
    downloaded += 1;
    const updated = statuses.lastUpdatedDates[video.id];
    if (isUpdateStale(updated, now)) {
      stale += 1;
    }
    const time = updated === undefined ? Number.NaN : Date.parse(updated);
    if (!Number.isNaN(time) && (Number.isNaN(newest) || time > newest)) {
      newest = time;
    }
  }

  return {
    videos: list.length,
    downloaded,
    notDownloaded: list.length - downloaded,
    stale,
    ...(Number.isNaN(newest) ? {} : { newestUpdate: new Date(newest).toISOString() }),
  };
}
