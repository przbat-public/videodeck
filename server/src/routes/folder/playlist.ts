import fs from 'node:fs/promises';
import path from 'node:path';
import type { DownloadPlaylistResponse } from '@videodeck/shared/api';
import { toChannelUrl } from '@videodeck/shared/youtube';
import { toCatalogEntry, trimPlaylistEntries } from '../../services/channelList';
import { readFolderConfig } from '../../services/folderConfig';
import { buildPlaylistArgs, runYtDlp } from '../../services/ytdlp';
import { writeJsonAtomic } from '../../utils/fsUtils';
import { logger } from '../../utils/logger';
import { createSingleFlight } from '../../utils/singleFlight';
import type { NoParams, RouteHandler } from '../http';
import { readBody, readString, sendError } from '../http';
import { invalidateStatusCache } from './config';
import { requireAllowedFolder, requireMountedFolder } from './guards';
import { invalidateSummaryCache } from './summaries';

/**
 * The channel fetch behind POST /api/folder/download-playlist.
 *
 * The configured channelUrl is re-validated here before it reaches yt-dlp:
 * a hand-edited config.json bypasses the save path, and a URL that is not an
 * https YouTube channel is an SSRF and argument-injection primitive.
 */

/** What one channel listing produced, shared by every request that joined it */
type ChannelListing = { ok: true; listPath: string; videoCount: number } | { ok: false; error: unknown };

/**
 * One listing per folder at a time. A second tab, a reload while the fetch
 * runs or a script used to start another yt-dlp for the same channel,
 * outside every queue limit. A request that arrives meanwhile now waits for
 * the listing already running and answers with its result; the entry goes
 * once it settles, so the next click lists again.
 */
const channelListings = createSingleFlight<string, ChannelListing>();

/** yt-dlp's NDJSON, one entry per line; a line that does not parse fails the listing */
function parsePlaylistLines(stdout: string): unknown[] {
  return stdout
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line): unknown => {
      try {
        return JSON.parse(line);
      } catch (parseError) {
        logger.error('Error parsing JSON line:', line.substring(0, 100));
        throw new Error(
          `Failed to parse JSON line: ${parseError instanceof Error ? parseError.message : 'Unknown error'}`,
          { cause: parseError },
        );
      }
    });
}

/**
 * Fetch the channel's video list with `yt-dlp --flat-playlist -j` and store
 * it as a JSON array in list.json. A yt-dlp failure is logged here once and
 * answered as a result, so every request that joined gets the same 500.
 */
async function listChannel(folderPath: string, channelUrl: string): Promise<ChannelListing> {
  await fs.mkdir(folderPath, { recursive: true });
  let stdout: string;
  try {
    stdout = await runYtDlp(buildPlaylistArgs(channelUrl), folderPath);
  } catch (execError) {
    logger.error('Error executing yt-dlp:', execError);
    return { ok: false, error: execError };
  }

  // The raw dump is kept trimmed: a flat-playlist entry carries about 40 keys
  // of playlist bookkeeping and thumbnail URLs, and this app reads six of
  // them. Writing the catalog shape keeps the file (and every later read of
  // it) an order of magnitude smaller, and the diff of two fetches readable.
  const catalog = trimPlaylistEntries(parsePlaylistLines(stdout));
  await writeJsonAtomic(folderPath, 'list.json', catalog.map(toCatalogEntry));
  // The file the console reads its row state and its counts from just changed,
  // and both answers are cached for seconds: without this the row it fetched
  // for keeps reporting "no list" and "0 videos" until the window lapses.
  invalidateStatusCache();
  invalidateSummaryCache();
  return { ok: true, listPath: path.join(folderPath, 'list.json'), videoCount: catalog.length };
}

/**
 * The handler: the config read and the URL check run for every request, then
 * the request joins its folder's listing.
 */
export const downloadPlaylist: RouteHandler<NoParams, DownloadPlaylistResponse> = async (req, res) => {
  const folderPath = requireAllowedFolder(readBody(req).folderPath, res);
  if (!folderPath) return;

  // Before the config read, not just before the write: the read would answer
  // 404 "create config.json" for a folder whose drive is away, which sends the
  // operator after the wrong problem.
  if (!(await requireMountedFolder(folderPath, res))) {
    return;
  }

  const config = await readFolderConfig(folderPath);
  if (!config) {
    res.status(404).json({
      error: 'config.json not found',
      message: 'Please create config.json file with channelUrl first',
    });
    return;
  }
  const configuredUrl = readString(config.channelUrl);
  if (configuredUrl === undefined) {
    res.status(400).json({
      error: 'channelUrl is not configured',
      message: 'Please set channelUrl in config.json file',
    });
    return;
  }
  // Defense in depth: the save path validates too, but a hand-edited
  // config.json bypasses it. The URL must be an https YouTube channel
  // before yt-dlp ever sees it, since anything else is an SSRF and
  // argument-injection primitive, and yt-dlp gets the rebuilt string only.
  const rebuiltUrl = toChannelUrl(configuredUrl);
  if (rebuiltUrl === null) {
    res.status(400).json({
      error: 'channelUrl is not a YouTube channel URL',
      message:
        'Please set channelUrl to a YouTube channel URL (https://youtube.com/@handle, /channel/…, /c/…, /user/…)',
    });
    return;
  }

  const channelUrl = rebuiltUrl.endsWith('/videos') ? rebuiltUrl : `${rebuiltUrl}/videos`;
  const listing = await channelListings.run(folderPath, () => listChannel(folderPath, channelUrl));
  if (!listing.ok) {
    sendError(res, 500, 'Failed to download playlist', listing.error);
    return;
  }
  res.json({
    success: true,
    message: 'Playlist downloaded successfully',
    listPath: listing.listPath,
    videoCount: listing.videoCount,
  });
};
