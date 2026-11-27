import type { ChannelVideo, FolderListResponse } from '@videodeck/shared/api';
import { toWatchUrl } from '@videodeck/shared/youtube';
import { titleFromStem } from '../utils/videoStem';
import { indexUntrackedVideos } from './folderIndex';

/**
 * The videos of a collection folder (`kind: "collection"` in config.json).
 * A collection gathers single downloads, so it has no list.json: its list is
 * whatever the folder index holds, newest upload first, every entry
 * downloaded. Videos downloaded outside the queue are indexed first, so a
 * yt-dlp run in a terminal shows up without a manual rebuild.
 */
export async function readCollection(folderPath: string): Promise<FolderListResponse> {
  const { index } = await indexUntrackedVideos(folderPath);
  const entries = Object.entries(index.entries).sort(([, a], [, b]) => b.baseName.localeCompare(a.baseName));

  const videos: ChannelVideo[] = [];
  const downloadStatuses: Record<string, boolean> = {};
  const lastUpdatedDates: Record<string, string> = {};
  for (const [id, entry] of entries) {
    videos.push({ id, title: entry.title ?? titleFromStem(entry.baseName, id), url: toWatchUrl(id) });
    downloadStatuses[id] = true;
    lastUpdatedDates[id] = entry.infoMtime;
  }
  return { videos, downloadStatuses, lastUpdatedDates };
}
