import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import type {
  AcceptedResponse,
  CategoriesResponse,
  ChannelsResponse,
  CommentsResponse,
  ReindexConflictResponse,
  ReindexStatus,
  SearchResponse,
  SortOption,
  SubtitleTrack,
  VideoDetails,
  VideoDetailsResponse,
  VideoListItem,
  VideoSummaryResponse,
} from '@shared/api';
import type { VideoInfoJson } from '../types';
import {
  getVideos,
  getReindexStatus,
  isReindexRunning,
  refreshVideosCache,
} from '../services/videoScanner';
import { getVideoFilePath, normalizeFolderPath } from '../utils/videoPathUtils';
import { stripUndefined } from '../utils/objectUtils';
import {
  getVideoByBaseName,
  getVideoByVideoId,
  getVideoByFilePath,
  getTotalVideoCount,
  listChannelNames,
  recreateAllIndices,
  SEARCH_DEFAULT_LIMIT,
} from '../services/elasticsearchService';
import type { SearchOptions } from '../services/elasticsearchService';
import { getFolderPathsForCategory, listCategories } from '../services/folderConfig';
import { generateSummary } from '../services/summaryService';
import { loadCommentTree } from '../services/commentStore';
import { getVideosFolderPaths } from '../config';
import { readString } from './http';
import type { NoParams, RouteHandler } from './http';
import { logger } from '../utils/logger';
import { stripVttCueSettings, vttLanguage } from '../utils/vttUtils';

// ---------------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------------

const SORT_OPTIONS: readonly SortOption[] = [
  'relevance',
  'date-desc',
  'date-asc',
  'views-desc',
  'views-asc',
  'likes-desc',
  'likes-asc',
];

function isSortOption(value: string): value is SortOption {
  return (SORT_OPTIONS as readonly string[]).includes(value);
}

/** `?sort=` value; unknown or missing values fall back to the default */
export function parseSortOption(value: unknown): SortOption {
  return typeof value === 'string' && isSortOption(value) ? value : 'date-desc';
}

/** `?offset=`/`?limit=` values; anything malformed falls back to the default */
function parseNonNegativeInt(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

const YOUTUBE_ID_RE = /^[a-zA-Z0-9_-]{11}$/;

/**
 * Look a video up by YouTube id (when the identifier looks like one) and
 * fall back to the file base name.
 */
async function findVideo(identifier: string): Promise<VideoListItem | null> {
  const byId = YOUTUBE_ID_RE.test(identifier) ? await getVideoByVideoId(identifier) : null;
  return byId ?? getVideoByBaseName(identifier);
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

// GET /api/videos/refreshCache/status - Progress of the running/last reindex
const getRefreshStatus: RouteHandler<NoParams, ReindexStatus> = (_req, res) => {
  res.json(getReindexStatus());
};

// GET /api/videos/refreshCache - Refresh/reindex videos cache.
// ?onlyMissing=1 reindexes only the folders whose cache does not exist in
// Elasticsearch yet, so a swapped-in disk with a cache from a previous
// session is searched immediately and only new folders are scanned.
const startRefresh: RouteHandler<NoParams, AcceptedResponse | ReindexConflictResponse> = (
  req,
  res
) => {
  if (isReindexRunning()) {
    res.status(409).json({
      error: 'Reindex already running',
      message: 'A reindex is already in progress',
      status: getReindexStatus(),
    });
    return;
  }

  const onlyMissingValue = readString(req.query.onlyMissing);
  const onlyMissing = onlyMissingValue === '1' || onlyMissingValue === 'true';
  logger.info(`Cache refresh requested${onlyMissing ? ' (onlyMissing)' : ''}...`);

  // Start the refresh process asynchronously (fire and forget)
  refreshVideosCache(onlyMissing ? { onlyMissing: true } : undefined).catch((error: unknown) => {
    logger.error('Error refreshing cache in background:', error);
  });

  // Return immediately
  res.status(200).json({
    message: 'Cache refresh process started',
    status: 'ok',
  });
};

// POST /api/videos/recreateIndices - Recreate all Elasticsearch indices
const recreateIndices: RouteHandler<NoParams, AcceptedResponse> = (_req, res) => {
  logger.info('Recreate indices requested...');

  // Start the recreate process asynchronously (fire and forget)
  recreateAllIndices().catch((error: unknown) => {
    logger.error('Error recreating indices in background:', error);
  });

  // Return immediately
  res.status(200).json({
    message: 'Indices recreation process started',
    status: 'ok',
  });
};

// GET /api/videos/search?q={query}&sort={sortOption}&category={category}&offset=&limit=
// The category is read from each folder's config.json and narrows the search
// to that category's folders; an unknown category matches no folder at all.
const search: RouteHandler<NoParams, SearchResponse> = async (req, res) => {
  const query = readString(req.query.q);
  const sort = parseSortOption(req.query.sort);
  const category = readString(req.query.category)?.trim();
  const offset = parseNonNegativeInt(readString(req.query.offset), 0);
  const limit = parseNonNegativeInt(readString(req.query.limit), SEARCH_DEFAULT_LIMIT);
  const channel = readString(req.query.channel)?.trim() || undefined;
  const dateFrom = parseDateFilter(readString(req.query.dateFrom));
  const dateTo = parseDateFilter(readString(req.query.dateTo));

  const folderPaths = category ? await getFolderPathsForCategory(category) : undefined;

  const options = stripUndefined<SearchOptions>({ offset, limit, channel, dateFrom, dateTo });
  const videos = await getVideos(query, sort, folderPaths, options);
  const totalCount = await getTotalVideoCount(folderPaths);

  res.json({ videos, totalCount });
};

/** yyyyMMdd from a user-entered date; anything malformed is ignored */
function parseDateFilter(value: string | undefined): string | undefined {
  const digits = (value ?? '').replace(/\D/g, '');
  return digits.length === 8 ? digits : undefined;
}

/** Top-level comments per page (details response and /comments endpoint) */
export const COMMENTS_PAGE_SIZE = 50;

// GET /api/videos/categories
const getCategories: RouteHandler<NoParams, CategoriesResponse> = async (_req, res) => {
  res.json({ categories: await listCategories() });
};

// GET /api/videos/channels - distinct channel names for the filter UI
const getChannelNames: RouteHandler<NoParams, ChannelsResponse> = async (_req, res) => {
  res.json({ channels: await listChannelNames() });
};

// GET /api/videos/file/:filename?folder=<folderPath>
// The folder is taken from the `folder` query param (must be one of the
// configured folders); without it we look the file name up in Elasticsearch.
const serveFile: RouteHandler<{ filename: string }, never> = async (req, res) => {
  const { filename } = req.params;
  const folderParam = req.query.folder;

  let folderPath: string | undefined;
  if (folderParam !== undefined) {
    const normalized =
      typeof folderParam === 'string' ? normalizeFolderPath(folderParam) : undefined;
    if (
      normalized === undefined ||
      !getVideosFolderPaths().some((allowed) => normalizeFolderPath(allowed) === normalized)
    ) {
      res
        .status(403)
        .json({ error: `Folder path is not in the allowed list: ${String(folderParam)}` });
      return;
    }
    folderPath = normalized;
  } else {
    try {
      const video = await getVideoByFilePath(filename);
      folderPath = video?.folderPath;
    } catch (lookupError) {
      logger.error('Error looking up file in Elasticsearch:', lookupError);
    }
    // A file that is not indexed cannot be served — never fall back to a
    // guessed folder (that used to leak files from the first configured one).
    if (folderPath === undefined) {
      res.status(404).json({ error: 'File not found' });
      return;
    }
  }

  const filePath = getVideoFilePath(filename, folderPath);

  // Check if file exists
  try {
    await fs.access(filePath);
  } catch {
    res.status(404).json({ error: 'File not found' });
    return;
  }

  // Determine content type
  const ext = path.extname(filename).toLowerCase();
  let contentType = 'application/octet-stream';

  if (ext === '.mp4') {
    contentType = 'video/mp4';
  } else if (ext === '.webp') {
    contentType = 'image/webp';
  } else if (ext === '.vtt') {
    // yt-dlp auto captions carry `align:start position:0%` on every cue,
    // pinning the text to the left edge — strip the settings so the browser
    // centers the cues the way it does for plain WebVTT.
    contentType = 'text/vtt; charset=utf-8';
    try {
      const vtt = await fs.readFile(filePath, 'utf-8');
      res.setHeader('Content-Type', contentType);
      res.end(stripVttCueSettings(vtt));
    } catch {
      res.status(404).json({ error: 'File not found' });
    }
    return;
  }

  res.setHeader('Content-Type', contentType);
  res.sendFile(path.resolve(filePath));
};

// GET /api/videos/:identifier/summary - supports both baseName and videoId
const getSummary: RouteHandler<{ identifier: string }, VideoSummaryResponse> = async (req, res) => {
  const video = await findVideo(req.params.identifier);

  if (!video) {
    res.status(404).json({ error: 'Video not found' });
    return;
  }

  if (!video.subtitlePath) {
    res.status(404).json({ error: 'Subtitle not found' });
    return;
  }

  // Cached summaries, VTT cleaning, OpenAI fallback and disk caching live in
  // the service; failures bubble up to the error handler middleware.
  const { summary, truncated } = await generateSummary({
    folderPath: video.folderPath,
    baseName: video.baseName,
    subtitlePath: video.subtitlePath,
  });

  // `truncated` is only present when true
  res.json(
    stripUndefined<VideoSummaryResponse>({ summary, truncated: truncated ? true : undefined })
  );
};

// GET /api/videos/:identifier/details - supports both baseName and videoId
const getDetails: RouteHandler<{ identifier: string }, VideoDetailsResponse> = async (req, res) => {
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
  const comments = commentsTree === null ? [] : commentsTree.slice(0, COMMENTS_PAGE_SIZE);
  const commentCount = commentsTree?.length ?? 0;

  // Every subtitle file the folder actually holds for this video, so the
  // player can offer each language instead of one hardcoded track.
  let subtitles: SubtitleTrack[] = [];
  try {
    const entries = (await fs.readdir(video.folderPath)) ?? [];
    const prefix = `${video.baseName}.`;
    subtitles = entries
      .filter((file) => file.startsWith(prefix) && file.endsWith('.vtt'))
      .map((file) => stripUndefined<SubtitleTrack>({ path: file, lang: vttLanguage(file) }))
      .sort((a, b) => a.path.localeCompare(b.path));
  } catch (error) {
    logger.warn(`Cannot list subtitles of ${video.folderPath}:`, error);
  }
  if (subtitles.length === 0 && video.subtitlePath) {
    // Fallback for videos indexed before subtitle listing existed
    subtitles = [
      stripUndefined<SubtitleTrack>({
        path: video.subtitlePath,
        lang: vttLanguage(video.subtitlePath),
      }),
    ];
  }

  const details = stripUndefined<VideoDetails>({
    title: infoJson.title || infoJson.fulltitle || '',
    description: infoJson.description || infoJson.title || infoJson.fulltitle || '',
    uploadDate: infoJson.upload_date || '',
    duration: infoJson.duration_string || (infoJson.duration ? String(infoJson.duration) : ''),
    viewCount: infoJson.view_count || 0,
    likeCount: infoJson.like_count || 0,
    channelName: infoJson.channel || infoJson.uploader || '',
    comments,
    commentCount,
    videoPath: video.videoPath,
    thumbnailPath: video.thumbnailPath,
    subtitlePath: video.subtitlePath,
    subtitles,
    folderPath: video.folderPath,
  });

  res.json({ details });
};

// GET /api/videos/:identifier/comments?offset=&limit= - one page of the
// comment tree; the same mtime-keyed cache as the details endpoint serves it
const getComments: RouteHandler<{ identifier: string }, CommentsResponse> = async (req, res) => {
  const video = await findVideo(req.params.identifier);

  if (!video) {
    res.status(404).json({ error: 'Video not found' });
    return;
  }

  const tree = await loadCommentTree(video.folderPath, video.baseName);
  if (tree === null) {
    res.json({ comments: [], totalCount: 0, offset: 0 });
    return;
  }

  const offset = parseNonNegativeInt(readString(req.query.offset), 0);
  const limit = Math.min(
    500,
    Math.max(1, parseNonNegativeInt(readString(req.query.limit), COMMENTS_PAGE_SIZE))
  );

  res.json({ comments: tree.slice(offset, offset + limit), totalCount: tree.length, offset });
};

// ---------------------------------------------------------------------------
// Routes (order matters: /file/:filename before the /:identifier routes)
// ---------------------------------------------------------------------------

const router = express.Router();

router.get('/refreshCache/status', getRefreshStatus);
router.get('/refreshCache', startRefresh);
router.post('/recreateIndices', recreateIndices);
router.get('/search', search);
router.get('/categories', getCategories);
router.get('/channels', getChannelNames);
router.get('/file/:filename', serveFile);
router.get('/:identifier/summary', getSummary);
router.get('/:identifier/comments', getComments);
router.get('/:identifier/details', getDetails);

export default router;
