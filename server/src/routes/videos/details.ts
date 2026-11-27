import fs from 'node:fs/promises';
import type {
  CommentWithReplies,
  SubtitleTrack,
  VideoDetails,
  VideoDetailsResponse,
  VideoListItem,
} from '@videodeck/shared/api';
import { COMMENTS_PAGE_SIZE } from '@videodeck/shared/schemas';
import { loadCommentTree } from '../../services/commentStore';
import { logger } from '../../utils/logger';
import { stripUndefined } from '../../utils/objectUtils';
import { findSubtitleFiles, vttLanguage } from '../../utils/vttUtils';
import type { RouteHandler } from '../http';
import { findVideo } from './helpers';

/**
 * GET /api/videos/:identifier/details: the metadata payload the player and the
 * details panel render.
 *
 * The text fields, the counts and the paths come from the video's index
 * document, which the lookup already fetched; the info.json is read only for
 * its comments, through the comment store, which parses it once per mtime. A
 * file rewritten outside the app shows its old fields until the folder is
 * indexed again, and its comments at once. Subtitle tracks come from the
 * folder listing, with the indexed subtitle path as the fallback for videos
 * indexed before that listing existed.
 */

/**
 * VTT files of a video, by the rule the index uses (utils/vttUtils.ts), sorted
 * by name; [] when the folder is unreadable.
 */
async function listSubtitles(folderPath: string, baseName: string): Promise<SubtitleTrack[]> {
  try {
    const entries = (await fs.readdir(folderPath)) ?? [];
    return findSubtitleFiles(baseName, entries)
      .map((file) => stripUndefined<SubtitleTrack>({ path: file, lang: vttLanguage(file) }))
      .sort((a, b) => a.path.localeCompare(b.path));
  } catch (error) {
    logger.warn(`Cannot list subtitles of ${folderPath}:`, error);
    return [];
  }
}

/**
 * The details payload: the indexed fields of the video, one page of its
 * comments and its subtitle tracks. The index already applied the fallbacks
 * (a title from the file name, the uploader for a missing channel, counts
 * read as numbers), so a field it left out is empty here.
 */
function buildDetails(
  video: VideoListItem,
  comments: CommentWithReplies[],
  commentCount: number,
  subtitles: SubtitleTrack[],
): VideoDetails {
  return stripUndefined<VideoDetails>({
    title: video.title,
    description: video.description ?? '',
    uploadDate: video.uploadDate ?? '',
    viewCount: video.viewCount ?? 0,
    likeCount: video.likeCount ?? 0,
    channelName: video.channelName ?? '',
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

  // The details response carries only the first page; the rest comes from
  // GET /:identifier/comments, and the comment store parses a huge info.json
  // once per mtime for both
  let commentsTree: CommentWithReplies[] | null;
  try {
    commentsTree = await loadCommentTree(video.folderPath, video.baseName);
  } catch (error) {
    logger.error(`Error reading or parsing the info.json of ${video.baseName} in ${video.folderPath}:`, error);
    if (error instanceof SyntaxError) {
      res.status(500).json({
        error: 'Invalid JSON format in video metadata',
        message: 'The video metadata file is corrupted or invalid',
      });
      return;
    }
    // Re-throw file read errors to the error handler middleware
    throw error;
  }
  if (commentsTree === null) {
    res.status(404).json({ error: 'Video details not found' });
    return;
  }
  const comments = commentsTree.slice(0, COMMENTS_PAGE_SIZE);

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

  const details = buildDetails(video, comments, commentsTree.length, subtitles);

  res.json({ details });
};
