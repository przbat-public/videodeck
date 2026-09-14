import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import type {
  AcceptedResponse,
  CategoriesResponse,
  ReindexConflictResponse,
  ReindexStatus,
  SearchResponse,
  SortOption,
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
import { buildCommentTree } from '../utils/commentTreeUtils';
import { stripUndefined } from '../utils/objectUtils';
import {
  getVideoByBaseName,
  getVideoByVideoId,
  getVideoByFilePath,
  getTotalVideoCount,
  recreateAllIndices,
  SEARCH_DEFAULT_LIMIT,
} from '../services/elasticsearchService';
import { getFolderPathsForCategory, listCategories } from '../services/folderConfig';
import { generateSummary } from '../services/summaryService';
import { getVideosFolderPaths } from '../config';
import { readString } from './http';
import type { NoParams, RouteHandler } from './http';
import { logger } from '../utils/logger';

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

  const folderPaths = category ? await getFolderPathsForCategory(category) : undefined;

  const videos = await getVideos(query, sort, folderPaths, { offset, limit });
  const totalCount = await getTotalVideoCount(folderPaths);

  res.json({ videos, totalCount });
};

// GET /api/videos/categories
const getCategories: RouteHandler<NoParams, CategoriesResponse> = async (_req, res) => {
  res.json({ categories: await listCategories() });
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
    contentType = 'text/vtt; charset=utf-8';
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

  const comments = buildCommentTree(infoJson.comments || []);

  const details = stripUndefined<VideoDetails>({
    title: infoJson.title || infoJson.fulltitle || '',
    description: infoJson.description || infoJson.title || infoJson.fulltitle || '',
    uploadDate: infoJson.upload_date || '',
    duration: infoJson.duration_string || (infoJson.duration ? String(infoJson.duration) : ''),
    viewCount: infoJson.view_count || 0,
    likeCount: infoJson.like_count || 0,
    channelName: infoJson.channel || infoJson.uploader || '',
    comments,
    commentCount: infoJson.comment_count || comments.length,
    videoPath: video.videoPath,
    thumbnailPath: video.thumbnailPath,
    subtitlePath: video.subtitlePath,
    folderPath: video.folderPath,
  });

  res.json({ details });
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
router.get('/file/:filename', serveFile);
router.get('/:identifier/summary', getSummary);
router.get('/:identifier/details', getDetails);

export default router;
