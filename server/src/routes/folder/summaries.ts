import type { FolderSummariesResponse, FolderSummary } from '@videodeck/shared/api';
import { getVideosFolderPaths } from '../../config';
import { readListJson } from '../../services/channelList';
import { readCollection } from '../../services/collection';
import { readFolderConfig } from '../../services/folderConfig';
import { getDownloadStatuses } from '../../services/folderIndex';
import { summarizeFolder } from '../../services/folderSummary';
import { logger } from '../../utils/logger';
import { runPool } from '../../utils/runPool';
import type { NoParams, RouteHandler } from '../http';
import { requireAllowedFolder } from './guards';

/**
 * Counts per folder for the download page's console.
 *
 * The cache and the read pool are module-level on purpose: one cached answer
 * and one concurrency limit behind every router instance. A single-folder
 * request refreshes that folder's entry in place, so a finished job does not
 * have to invalidate the whole answer.
 */

/** 5 s cache of GET /api/folder/summaries keyed by the expanded folder list */
const SUMMARY_CACHE_TTL_MS = 5_000;
/** Folders read at once: the console asks for every channel on one page load */
const SUMMARY_READ_CONCURRENCY = 8;
let summaryCache: { key: string; readAt: number; body: FolderSummariesResponse } | null = null;

function readSummaryCache(folderPaths: string[]): FolderSummariesResponse | undefined {
  const cached = summaryCache;
  if (cached === null || cached.key !== folderPaths.join('\n') || Date.now() - cached.readAt >= SUMMARY_CACHE_TTL_MS) {
    return undefined;
  }
  return cached.body;
}

function writeSummaryCache(folderPaths: string[], body: FolderSummariesResponse): void {
  summaryCache = { key: folderPaths.join('\n'), readAt: Date.now(), body };
}

/**
 * Replace one folder's counts in the cached answer, if there is one. A single
 * folder is read fresh right after its job finished; without this the next
 * full answer inside the cache window would roll the folder back.
 */
function patchSummaryCache(folderPath: string, summary: FolderSummary): void {
  if (summaryCache !== null) {
    summaryCache.body.summaries[folderPath] = summary;
  }
}

/** Counts of one folder; a folder that cannot be read reports zeroes */
async function summarizeOne(folderPath: string): Promise<FolderSummary> {
  try {
    // Read in parallel: nearly every folder is a channel, and the config read
    // must not add a disk round trip to each of them
    const [config, list, statuses] = await Promise.all([
      readFolderConfig(folderPath),
      readListJson(folderPath),
      getDownloadStatuses(folderPath),
    ]);
    if (config?.kind === 'collection') {
      const collection = await readCollection(folderPath);
      return summarizeFolder(collection.videos, collection);
    }
    return summarizeFolder(list, statuses);
  } catch (error) {
    logger.error(`Cannot summarize ${folderPath}:`, error);
    return { videos: 0, downloaded: 0, notDownloaded: 0, stale: 0 };
  }
}

/** Tests: drop the summaries cache */
export function invalidateSummaryCache(): void {
  summaryCache = null;
}

/**
 * Counts per channel for the download page's console: one request for every
 * configured folder instead of one per row. `list.json` and the folder index
 * are two reads per folder on disk, so the reads run through a pool and the
 * answer is cached for a few seconds; a folder that cannot be read reports
 * zeroes and never fails the whole response.
 *
 * With `?folderPath=` the answer holds that one folder, read fresh: the
 * console asks for it when a job of that folder finishes, so the counts
 * follow the downloads without re-reading every folder on every job.
 */
export const getFolderSummaries: RouteHandler<NoParams, FolderSummariesResponse> = async (req, res) => {
  if (req.query.folderPath !== undefined) {
    const folderPath = requireAllowedFolder(req.query.folderPath, res);
    if (!folderPath) return;
    const summary = await summarizeOne(folderPath);
    patchSummaryCache(folderPath, summary);
    res.json({ summaries: { [folderPath]: summary } });
    return;
  }

  const videosFolderPaths = getVideosFolderPaths();
  const cached = readSummaryCache(videosFolderPaths);
  if (cached !== undefined) {
    res.json(cached);
    return;
  }

  const summaries: FolderSummariesResponse['summaries'] = {};
  await runPool(videosFolderPaths, SUMMARY_READ_CONCURRENCY, async (folderPath) => {
    summaries[folderPath] = await summarizeOne(folderPath);
  });

  const body: FolderSummariesResponse = { summaries };
  writeSummaryCache(videosFolderPaths, body);
  res.json(body);
};
