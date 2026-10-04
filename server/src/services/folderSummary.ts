import type { ChannelVideo, FolderSummary } from '@videodeck/shared/api';
import { isUpdateStale } from '@videodeck/shared/dates';

/** What the folder index knows about a folder's videos */
export interface FolderIndexStatuses {
  downloadStatuses: Record<string, boolean>;
  lastUpdatedDates: Record<string, string>;
}

const EMPTY_SUMMARY: FolderSummary = { videos: 0, downloaded: 0, notDownloaded: 0, unavailable: 0, stale: 0 };

/**
 * Count what the console shows for one channel: how many playlist videos are
 * downloaded, how many are missing, how many of those cannot arrive at all,
 * how many downloads are stale and when the folder was last touched.
 *
 * Only videos that `list.json` still contains are counted. The folder index
 * keeps entries for videos removed from the channel, and letting those reach
 * the counts would report more downloads than videos.
 */
export function summarizeFolder(
  list: readonly ChannelVideo[] | null,
  statuses: FolderIndexStatuses,
  /** Ids the catalog or the failure record calls undownloadable */
  unavailable: ReadonlySet<string>,
  now: number = Date.now(),
): FolderSummary {
  if (list === null || list.length === 0) {
    return { ...EMPTY_SUMMARY };
  }

  const isOnDisk = (video: ChannelVideo): boolean => statuses.downloadStatuses[video.id] === true;
  const onDisk = list.filter(isOnDisk);
  // A video on disk is never unavailable: the files are the answer, whatever
  // the catalog or an old failure said about it.
  const unavailableCount = list.filter((video) => !isOnDisk(video) && unavailable.has(video.id)).length;
  const updatedDates = onDisk.map((video) => statuses.lastUpdatedDates[video.id]);
  const parsedDates = updatedDates
    .map((value) => (value === undefined ? Number.NaN : Date.parse(value)))
    .filter((time) => !Number.isNaN(time));
  // Folded rather than spread into Math.max: a channel can list tens of
  // thousands of videos, past the argument limit of a spread call.
  const newest = parsedDates.reduce((max, time) => (time > max ? time : max), Number.NEGATIVE_INFINITY);

  return {
    videos: list.length,
    downloaded: onDisk.length,
    notDownloaded: list.length - onDisk.length,
    unavailable: unavailableCount,
    stale: updatedDates.filter((value) => isUpdateStale(value, now)).length,
    ...(Number.isFinite(newest) ? { newestUpdate: new Date(newest).toISOString() } : {}),
  };
}
