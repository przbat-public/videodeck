import type {
  ArchiveDrift,
  ArchiveMethod,
  ArchiveReconcileResponse,
  ChannelVideo,
  DownloadOptions,
  DownloadState,
  EnqueueJobsResponse,
  FolderStateResponse,
  SkippedVideo,
  VideoStateResponse,
} from '@videodeck/shared/api';
import { isYoutubeVideoId } from '@videodeck/shared/youtube';
import type { Response } from 'express';
import { archiveDrift, readArchive, reconcileArchive } from '../../services/archive';
import { readListJson } from '../../services/channelList';
import type { EnqueueRequest } from '../../services/downloadQueue';
import { loadDownloadOptions, readFolderConfig } from '../../services/folderConfig';
import type { FolderIndex } from '../../services/folderIndex';
import { loadIndex } from '../../services/folderIndex';
import type { WantedSidecars } from '../../services/videoState';
import { needsRepair, videoDownloadState, wantedSidecars } from '../../services/videoState';
import { stripUndefined } from '../../utils/objectUtils';
import type { NoParams, RouteHandler } from '../http';
import { readBody, readString } from '../http';
import { requireAllowedFolder, requireMountedFolder } from './guards';
import type { DownloadQueueLike } from './queue';

/**
 * The per-video state of a folder: what each video of the channel has on disk,
 * what it is still missing, which videos only exist on disk, and how far
 * `archive.txt` has drifted from both.
 *
 * One read of the folder index, one of `list.json` and one of the archive, no
 * per-video file walks: the index already recorded the per-file facts when it
 * was built.
 */

/** A state with nothing on disk and nothing in the archive */
const EMPTY_STATE: DownloadState = {
  files: null,
  archive: { onDisk: false, inArchive: false, drift: false },
  missing: [],
};

export interface FolderState {
  index: FolderIndex;
  /** Rows of the catalog, each with its state */
  videos: ChannelVideo[];
  /** Videos on disk that the catalog no longer lists */
  orphans: ChannelVideo[];
  drift: ArchiveDrift;
  wanted: WantedSidecars;
}

/** One video as the console renders it, built from the catalog row and the index */
function toRow(
  video: { id: string; title: string; url: string },
  index: FolderIndex,
  archiveIds: ReadonlySet<string>,
  wanted: WantedSidecars,
): ChannelVideo {
  const entry = index.entries[video.id];
  const state = videoDownloadState({ entry: entry ?? null, inArchive: archiveIds.has(video.id) }, wanted);
  return {
    title: video.title,
    url: video.url,
    id: video.id,
    downloadState: state,
  };
}

/** A video that is only on disk, described from its index entry */
function toOrphan(
  id: string,
  index: FolderIndex,
  archiveIds: ReadonlySet<string>,
  wanted: WantedSidecars,
): ChannelVideo {
  const entry = index.entries[id];
  return {
    title: entry?.title ?? entry?.baseName ?? id,
    url: `https://www.youtube.com/watch?v=${id}`,
    id,
    downloadState: videoDownloadState({ entry: entry ?? null, inArchive: archiveIds.has(id) }, wanted),
    orphan: true,
  };
}

/**
 * The whole folder's state, the one place that joins the three sources:
 * `list.json` (what the channel has), the folder index (what the disk has) and
 * `archive.txt` (what yt-dlp believes it downloaded).
 */
export async function readFolderState(folderPath: string): Promise<FolderState> {
  const [list, index, archiveIds, config] = await Promise.all([
    readListJson(folderPath).catch(() => null),
    loadIndex(folderPath),
    readArchive(folderPath),
    readFolderConfig(folderPath),
  ]);
  const wanted = wantedSidecars(config);
  const rows = list ?? [];
  const listedIds = new Set(rows.map((row) => row.id));

  const videos = rows.map((row) => toRow({ id: row.id, title: row.title, url: row.url }, index, archiveIds, wanted));
  const orphans = Object.keys(index.entries)
    .filter((id) => !listedIds.has(id))
    .sort((a, b) => a.localeCompare(b))
    .map((id) => toOrphan(id, index, archiveIds, wanted));

  return { index, videos, orphans, drift: archiveDrift(index, archiveIds), wanted };
}

/** The counts the console shows above the list */
function countsOf(state: FolderState): FolderStateResponse['counts'] {
  let downloaded = 0;
  let incomplete = 0;
  for (const video of state.videos) {
    const download = video.downloadState;
    if (download?.files == null) {
      continue;
    }
    downloaded += 1;
    if (needsRepair(download)) {
      incomplete += 1;
    }
  }
  return {
    videos: state.videos.length,
    downloaded,
    incomplete,
    notDownloaded: state.videos.length - downloaded,
    orphans: state.orphans.length,
  };
}

export type StateFilter = 'all' | 'incomplete' | 'orphan' | 'not-downloaded';

/** Whether a row survives the console's filter */
function matchesFilter(video: ChannelVideo, filter: StateFilter): boolean {
  const download = video.downloadState;
  if (filter === 'incomplete') {
    return download !== undefined && needsRepair(download);
  }
  if (filter === 'not-downloaded') {
    return download?.files == null;
  }
  return true;
}

function readFilter(value: unknown, res: Response<FolderStateResponse | { error: string }>): StateFilter | false {
  const raw = readString(value) ?? 'all';
  if (raw === 'all' || raw === 'incomplete' || raw === 'orphan' || raw === 'not-downloaded') {
    return raw;
  }
  res.status(400).json({ error: 'filter must be all, incomplete, orphan or not-downloaded' });
  return false;
}

export const getFolderState: RouteHandler<NoParams, FolderStateResponse> = async (req, res) => {
  const folderPath = requireAllowedFolder(req.query.folderPath, res);
  if (!folderPath) return;
  const filter = readFilter(req.query.filter, res);
  if (filter === false) return;
  // Before the state read, which builds the folder index from disk: a drive
  // that is away would answer "0 videos, nothing downloaded" for a channel
  // whose files are all there, and the console would believe it.
  if (!(await requireMountedFolder(folderPath, res))) {
    return;
  }

  const state = await readFolderState(folderPath);
  res.json({
    folderPath,
    videos: filter === 'orphan' ? [] : state.videos.filter((video) => matchesFilter(video, filter)),
    orphans: filter === 'incomplete' || filter === 'not-downloaded' ? [] : state.orphans,
    drift: state.drift,
    counts: countsOf(state),
  });
};

/**
 * One video's state, for the detail panel and for the console's link from the
 * search page. `known: false` is the honest answer for an id the folder has
 * never seen, rather than an empty state that reads like "not downloaded yet".
 */
export const getVideoState: RouteHandler<NoParams, VideoStateResponse> = async (req, res) => {
  const folderPath = requireAllowedFolder(req.query.folderPath, res);
  if (!folderPath) return;
  const videoId = readString(req.query.videoId);
  if (videoId === undefined) {
    res.status(400).json({ error: 'videoId is required' });
    return;
  }
  if (!isYoutubeVideoId(videoId)) {
    res.status(400).json({ error: 'videoId is not a valid YouTube video id' });
    return;
  }
  if (!(await requireMountedFolder(folderPath, res))) {
    return;
  }

  const state = await readFolderState(folderPath);
  const video = state.videos.find((row) => row.id === videoId) ?? state.orphans.find((row) => row.id === videoId);
  res.json({
    folderPath,
    videoId,
    known: video !== undefined,
    state: video?.downloadState ?? EMPTY_STATE,
  });
};

/** `POST /api/folder/archive/reconcile` */
export const reconcileFolderArchive: RouteHandler<NoParams, ArchiveReconcileResponse> = async (req, res) => {
  const body = readBody(req);
  const folderPath = requireAllowedFolder(body.folderPath, res);
  if (!folderPath) return;
  if (!(await requireMountedFolder(folderPath, res))) {
    return;
  }

  const method = readString(body.method);
  if (method !== 'add' && method !== 'remove' && method !== 'rebuild') {
    res.status(400).json({ error: 'method must be add, remove or rebuild' });
    return;
  }
  const rawIds = body.videoIds;
  if (rawIds !== undefined && !Array.isArray(rawIds)) {
    res.status(400).json({ error: 'videoIds must be an array of video ids' });
    return;
  }
  const videoIds = (rawIds ?? []).map((id) => readString(id) ?? '');
  const invalid = videoIds.find((id) => !isYoutubeVideoId(id));
  if (invalid !== undefined) {
    res.status(400).json({ error: `videoIds contains an invalid YouTube video id: ${JSON.stringify(invalid)}` });
    return;
  }

  const index = await loadIndex(folderPath);
  try {
    const result = await reconcileArchive(folderPath, method as ArchiveMethod, index, videoIds);
    // Read the file back rather than trusting the plan: the drift the response
    // reports is what a later run will actually see on disk.
    res.json({ ...result, drift: archiveDrift(index, await readArchive(folderPath)) });
  } catch (error) {
    // The only throw the service has is the unmounted-drive refusal, and it is
    // the caller's answer rather than a server fault: the folder is empty
    // because the drive is away.
    res.status(409).json({ error: error instanceof Error ? error.message : 'archive reconcile refused' });
  }
};

/**
 * One entry of a repair body as an enqueue request, or the reason it cannot be
 * repaired. A repair only makes sense for a video that is on disk: the job
 * reuses the file stem the folder index already recorded, and there is nothing
 * to refresh without it.
 */
function toRepairRequest(
  raw: unknown,
  folderPath: string,
  index: FolderIndex,
  options: DownloadOptions,
  method: 'sidecars' | 'comments',
): { request: EnqueueRequest } | { skipped: SkippedVideo } {
  const videoId = readString((raw as { videoId?: unknown } | null)?.videoId) ?? '';
  if (!isYoutubeVideoId(videoId)) {
    return { skipped: { videoId, reason: 'videoId is not a valid YouTube video id' } };
  }
  const entry = index.entries[videoId];
  if (entry === undefined) {
    return { skipped: { videoId, reason: 'not downloaded' } };
  }
  return {
    request: stripUndefined<EnqueueRequest>({
      folderPath,
      videoId,
      videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
      ...(entry.title === undefined ? {} : { title: entry.title }),
      type: 'repair',
      baseName: entry.baseName,
      options,
      ...(method === 'comments' ? { writeComments: true } : {}),
    }),
  };
}

/** Every entry of a repair body turned into a request or a skip reason */
function toRepairRequests(
  rawVideos: unknown[],
  folderPath: string,
  index: FolderIndex,
  options: DownloadOptions,
  method: 'sidecars' | 'comments',
): { requests: EnqueueRequest[]; skipped: SkippedVideo[] } {
  const requests: EnqueueRequest[] = [];
  const skipped: SkippedVideo[] = [];
  for (const raw of rawVideos) {
    const outcome = toRepairRequest(raw, folderPath, index, options, method);
    if ('request' in outcome) {
      requests.push(outcome.request);
    } else {
      skipped.push(outcome.skipped);
    }
  }
  return { requests, skipped };
}

/** The repair method of a body, or null when it is not one we know */
function readRepairMethod(value: unknown): 'sidecars' | 'comments' | null {
  const method = readString(value) ?? 'sidecars';
  return method === 'sidecars' || method === 'comments' ? method : null;
}

/** `POST /api/folder/repair` — queue sidecar-only jobs for the videos named */
export function createRepairHandler(queue: DownloadQueueLike): RouteHandler<NoParams, EnqueueJobsResponse> {
  return async (req, res) => {
    const body = readBody(req);
    const folderPath = requireAllowedFolder(body.folderPath, res);
    if (!folderPath) return;
    if (!(await requireMountedFolder(folderPath, res))) {
      return;
    }

    const method = readRepairMethod(body.method);
    if (method === null) {
      res.status(400).json({ error: 'method must be sidecars or comments' });
      return;
    }
    const rawVideos = Array.isArray(body.videos) ? body.videos : [];
    if (rawVideos.length === 0) {
      res.status(400).json({ error: 'videos must be a non-empty array' });
      return;
    }

    const [index, downloadOptions] = await Promise.all([loadIndex(folderPath), loadDownloadOptions(folderPath)]);

    const { requests, skipped } = toRepairRequests(rawVideos, folderPath, index, downloadOptions, method);
    const jobs = requests.length > 0 ? queue.enqueue(requests) : [];
    res.status(202).json({ jobs, skipped });
  };
}
