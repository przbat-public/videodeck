import type { ChannelVideo } from '@videodeck/shared/api';
import { isOlderThanMonth } from './videoDates';

/**
 * Which videos a bulk action should touch, shared by the per-channel video
 * list and the console's row actions. The rules are pure and live in one
 * place: "missing" and "stale" deciding differently in the two views is the
 * kind of drift that ends with a "download all" button queueing videos that
 * are already there.
 */

/** A video can only be fetched when it carries a url */
const withUrl = (video: ChannelVideo): boolean => video.url !== '';

/** Videos that are not downloaded yet: what "download all" queues */
export function selectDownloadable(
  videos: readonly ChannelVideo[],
  downloadStatuses: Record<string, boolean>,
): ChannelVideo[] {
  return videos.filter((video) => withUrl(video) && !downloadStatuses[video.id]);
}

/** Videos that are already downloaded: what "update all" queues */
export function selectDownloaded(
  videos: readonly ChannelVideo[],
  downloadStatuses: Record<string, boolean>,
): ChannelVideo[] {
  return videos.filter((video) => withUrl(video) && Boolean(downloadStatuses[video.id]));
}

/**
 * Downloaded videos whose metadata is older than a month (or has no usable
 * date): what "update stale" queues.
 */
export function selectStale(
  videos: readonly ChannelVideo[],
  downloadStatuses: Record<string, boolean>,
  lastUpdatedDates: Record<string, string>,
  now: number = Date.now(),
): ChannelVideo[] {
  return selectDownloaded(videos, downloadStatuses).filter((video) =>
    isOlderThanMonth(lastUpdatedDates[video.id], now),
  );
}
