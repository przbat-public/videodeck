import fs from 'node:fs/promises';
import path from 'node:path';
import type { DownloadPlaylistResponse } from '@videodeck/shared/api';
import { isYoutubeChannelUrl } from '@videodeck/shared/youtube';
import { readFolderConfig } from '../../services/folderConfig';
import { buildPlaylistArgs, runYtDlp } from '../../services/ytdlp';
import { writeJsonAtomic } from '../../utils/fsUtils';
import { logger } from '../../utils/logger';
import type { NoParams, RouteHandler } from '../http';
import { readBody, readString, sendError } from '../http';
import { requireAllowedFolder } from './guards';

/**
 * The channel fetch behind POST /api/folder/download-playlist.
 *
 * The configured channelUrl is re-validated here before it reaches yt-dlp:
 * a hand-edited config.json bypasses the save path, and a URL that is not an
 * https YouTube channel is an SSRF and argument-injection primitive.
 */

/**
 * Fetch the channel's video list with `yt-dlp --flat-playlist -j` and store
 * it as a JSON array in list.json.
 */
export const downloadPlaylist: RouteHandler<NoParams, DownloadPlaylistResponse> = async (req, res) => {
  const folderPath = requireAllowedFolder(readBody(req).folderPath, res);
  if (!folderPath) return;

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
  // before yt-dlp ever sees it — anything else is an SSRF/argument-
  // injection primitive.
  if (!isYoutubeChannelUrl(configuredUrl)) {
    res.status(400).json({
      error: 'channelUrl is not a YouTube channel URL',
      message:
        'Please set channelUrl to a YouTube channel URL (https://youtube.com/@handle, /channel/…, /c/…, /user/…)',
    });
    return;
  }

  await fs.mkdir(folderPath, { recursive: true });
  const channelUrl = configuredUrl.endsWith('/videos') ? configuredUrl : `${configuredUrl}/videos`;

  let stdout: string;
  try {
    stdout = await runYtDlp(buildPlaylistArgs(channelUrl), folderPath);
  } catch (execError) {
    logger.error('Error executing yt-dlp:', execError);
    sendError(res, 500, 'Failed to download playlist', execError);
    return;
  }

  const entries: unknown[] = stdout
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

  const listPath = path.join(folderPath, 'list.json');
  await writeJsonAtomic(folderPath, 'list.json', entries);
  res.json({
    success: true,
    message: 'Playlist downloaded successfully',
    listPath,
    videoCount: entries.length,
  });
};
