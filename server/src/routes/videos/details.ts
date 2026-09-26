import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  CommentWithReplies,
  SubtitleTrack,
  VideoDetails,
  VideoDetailsResponse,
  VideoListItem,
} from '@videodeck/shared/api';
import { COMMENTS_PAGE_SIZE } from '@videodeck/shared/schemas';
import { loadCommentTree } from '../../services/commentStore';
import type { VideoInfoJson } from '../../types';
import { logger } from '../../utils/logger';
import { stripUndefined } from '../../utils/objectUtils';
import { vttLanguage } from '../../utils/vttUtils';
import type { RouteHandler } from '../http';
import { findVideo } from './helpers';

/**
 * GET /api/videos/:identifier/details: the metadata payload the player and the
 * details panel render.
 *
 * info.json supplies the text fields and the indexed video item the paths; the
 * comment store parses info.json once per mtime. Subtitle tracks come from the
 * folder listing, with the indexed subtitle path as the fallback for videos
 * indexed before that listing existed.
 */

/**
 * VTT files of a video, sorted by name; [] when the folder is unreadable.
 */
async function listSubtitles(folderPath: string, baseName: string): Promise<SubtitleTrack[]> {
  try {
    const entries = (await fs.readdir(folderPath)) ?? [];
    const prefix = `${baseName}.`;
    return entries
      .filter((file) => file.startsWith(prefix) && file.endsWith('.vtt'))
      .map((file) => stripUndefined<SubtitleTrack>({ path: file, lang: vttLanguage(file) }))
      .sort((a, b) => a.path.localeCompare(b.path));
  } catch (error) {
    logger.warn(`Cannot list subtitles of ${folderPath}:`, error);
    return [];
  }
}

/** First truthy value among the candidates (0, '' and undefined fall through) */
function firstTruthy<T>(...values: Array<T | undefined | null>): T | undefined {
  for (const value of values) {
    if (value) {
      return value;
    }
  }
  return undefined;
}

/** Human-readable duration: `duration_string` wins, numeric `duration` is the fallback */
function durationString(info: VideoInfoJson): string {
  if (info.duration_string) {
    return info.duration_string;
  }
  if (!info.duration) {
    return '';
  }
  // yt-dlp `duration` is whole seconds — format it instead of showing "630"
  const totalSeconds = Math.floor(info.duration);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${minutes}:${ss}`;
}

/** The details payload assembled from info.json + the indexed video item */
function buildDetails(
  infoJson: VideoInfoJson,
  video: VideoListItem,
  comments: CommentWithReplies[],
  commentCount: number,
  subtitles: SubtitleTrack[],
): VideoDetails {
  return stripUndefined<VideoDetails>({
    title: firstTruthy(infoJson.title, infoJson.fulltitle) ?? '',
    description: firstTruthy(infoJson.description, infoJson.title, infoJson.fulltitle) ?? '',
    uploadDate: firstTruthy(infoJson.upload_date) ?? '',
    duration: durationString(infoJson),
    viewCount: firstTruthy(infoJson.view_count) ?? 0,
    likeCount: firstTruthy(infoJson.like_count) ?? 0,
    channelName: firstTruthy(infoJson.channel, infoJson.uploader) ?? '',
    comments,
    commentCount,
    videoPath: video.videoPath ?? '',
    thumbnailPath: video.thumbnailPath,
    subtitlePath: video.subtitlePath,
    subtitles,
    folderPath: video.folderPath,
  });
}

// GET /api/videos/:identifier/details - supports both baseName and videoId
export const getDetails: RouteHandler<{ identifier: string }, VideoDetailsResponse> = async (req, res) => {
  const video = await findVideo(req.params.identifier);

  if (!video) {
    res.status(404).json({ error: 'Video not found' });
    return;
  }

  // Use the folder path from the video item
  const infoJsonPath = path.join(video.folderPath, `${video.baseName}.info.json`);

  // Check if video file details exist
  try {
    await fs.access(infoJsonPath);
  } catch {
    res.status(404).json({ error: 'Video details not found' });
    return;
  }

  // Read and parse info.json
  let infoJson: VideoInfoJson;
  try {
    const infoJsonContent = await fs.readFile(infoJsonPath, 'utf-8');
    infoJson = JSON.parse(infoJsonContent) as VideoInfoJson;
  } catch (parseError) {
    logger.error(`Error reading or parsing info.json file ${infoJsonPath}:`, parseError);
    if (parseError instanceof SyntaxError) {
      res.status(500).json({
        error: 'Invalid JSON format in video metadata',
        message: 'The video metadata file is corrupted or invalid',
      });
      return;
    }
    // Re-throw file read errors to the error handler middleware
    throw parseError;
  }

  const commentsTree = await loadCommentTree(video.folderPath, video.baseName);
  // The details response carries only the first page; the rest comes from
  // GET /:identifier/comments — huge info.json files are parsed once and
  // cached by mtime (services/commentStore).
  const comments = commentsTree?.slice(0, COMMENTS_PAGE_SIZE) ?? [];
  const commentCount = commentsTree?.length ?? 0;

  // Every subtitle file the folder actually holds for this video, so the
  // player can offer each language instead of one hardcoded track.
  let subtitles = await listSubtitles(video.folderPath, video.baseName);
  if (subtitles.length === 0 && video.subtitlePath) {
    // Fallback for videos indexed before subtitle listing existed
    subtitles = [
      stripUndefined<SubtitleTrack>({
        path: video.subtitlePath,
        lang: vttLanguage(video.subtitlePath),
      }),
    ];
  }

  const details = buildDetails(infoJson, video, comments, commentCount, subtitles);

  res.json({ details });
};
