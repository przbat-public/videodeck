import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  AcceptedResponse,
  ApiError,
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
import type { Response } from 'express';
import express from 'express';
import { getVideosFolderPaths } from '../config';
import { loadCommentTree } from '../services/commentStore';
import type { SearchOptions } from '../services/elasticsearchService';
import {
  getTotalVideoCount,
  getVideoByBaseName,
  getVideoByFilePath,
  getVideoByVideoId,
  listChannelNames,
  recreateAllIndices,
  SEARCH_DEFAULT_LIMIT,
} from '../services/elasticsearchService';
import { getFolderPathsForCategory, listCategories } from '../services/folderConfig';
import { generateSummary } from '../services/summaryService';
import { getReindexStatus, getVideos, isReindexRunning, refreshVideosCache } from '../services/videoScanner';
import type { VideoInfoJson } from '../types';
import { logger } from '../utils/logger';
import { stripUndefined } from '../utils/objectUtils';
import { getVideoFilePath, normalizeFolderPath } from '../utils/videoPathUtils';
import { stripVttCueSettings, vttLanguage } from '../utils/vttUtils';
import type { NoParams, RouteHandler } from './http';
import { readString } from './http';

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
  return info.duration_string || (info.duration ? String(info.duration) : '');
}

/** Content type and cache headers for a served file extension */
function fileContentType(ext: string): { contentType: string; immutable: boolean } {
  if (ext === '.mp4') {
    return { contentType: 'video/mp4', immutable: true };
  }
  if (ext === '.webp') {
    return { contentType: 'image/webp', immutable: true };
  }
  if (ext === '.vtt') {
    return { contentType: 'text/vtt; charset=utf-8', immutable: false };
  }
  return { contentType: 'application/octet-stream', immutable: false };
}

/**
 * Resolve the folder a file must be served from. With `?folder=` it has to be
 * one of the configured folders; without it the file name is looked up in
 * Elasticsearch. Sends the proper error response and returns undefined when
 * the folder cannot be determined.
 */
async function resolveServeFolder<Res>(
  filename: string,
  folderParam: unknown,
  res: Response<Res | ApiError>,
): Promise<string | undefined> {
  if (folderParam !== undefined) {
    const normalized = typeof folderParam === 'string' ? normalizeFolderPath(folderParam) : undefined;
    if (
      normalized === undefined ||
      !getVideosFolderPaths().some((allowed) => normalizeFolderPath(allowed) === normalized)
    ) {
      res.status(403).json({ error: `Folder path is not in the allowed list: ${String(folderParam)}` });
      return undefined;
    }
    return normalized;
  }
  try {
    const video = await getVideoByFilePath(filename);
    if (video?.folderPath !== undefined) {
      return video.folderPath;
    }
  } catch (lookupError) {
    logger.error('Error looking up file in Elasticsearch:', lookupError);
  }
  // A file that is not indexed cannot be served — never fall back to a
  // guessed folder (that used to leak files from the first configured one).
  res.status(404).json({ error: 'File not found' });
  return undefined;
}

/**
 * True when the (already normalized) folder is one of the configured video
 * folders. Used by serveFile to keep the authorization guard on the same
 * code path as the file reads.
 */
function isAllowedVideoFolder(folderPath: string): boolean {
  return getVideosFolderPaths().some((allowed) => normalizeFolderPath(allowed) === normalizeFolderPath(folderPath));
}

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
const startRefresh: RouteHandler<NoParams, AcceptedResponse | ReindexConflictResponse> = (req, res) => {
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
  const folderPath = await resolveServeFolder(filename, req.query.folder, res);
  if (folderPath === undefined) {
    return;
  }
  // Final allowlist assertion next to the file sinks: the guard must live on
  // the same code path as the reads so authorization cannot drift from use
  // (the Elasticsearch-lookup branch is re-checked here too).
  if (!isAllowedVideoFolder(folderPath)) {
    res.status(403).json({ error: `Folder path is not in the allowed list: ${folderPath}` });
    return;
  }

  const filePath = getVideoFilePath(filename, folderPath);

  // Check if file exists
  try {
    await fs.access(filePath);
  } catch {
    res.status(404).json({ error: 'File not found' });
    return;
  }

  const ext = path.extname(filename).toLowerCase();

  if (ext === '.vtt') {
    // yt-dlp auto captions carry `align:start position:0%` on every cue,
    // pinning the text to the left edge — strip the settings so the browser
    // centers the cues the way it does for plain WebVTT. Subtitles are
    // re-downloaded in place on metadata updates — always revalidate, never
    // serve a stale cue file.
    try {
      const vtt = await fs.readFile(filePath, 'utf-8');
      res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.end(stripVttCueSettings(vtt));
    } catch {
      res.status(404).json({ error: 'File not found' });
    }
    return;
  }

  const { contentType, immutable } = fileContentType(ext);
  res.setHeader('Content-Type', contentType);
  if (immutable) {
    // Videos and thumbnails are content-addressed by their yt-dlp file stem:
    // a new version gets a new name, so the same URL always serves the same
    // bytes.
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  }
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
  res.json(stripUndefined<VideoSummaryResponse>({ summary, truncated: truncated ? true : undefined }));
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

  const details = stripUndefined<VideoDetails>({
    title: firstTruthy(infoJson.title, infoJson.fulltitle) ?? '',
    description: firstTruthy(infoJson.description, infoJson.title, infoJson.fulltitle) ?? '',
    uploadDate: firstTruthy(infoJson.upload_date) ?? '',
    duration: durationString(infoJson),
    viewCount: firstTruthy(infoJson.view_count) ?? 0,
    likeCount: firstTruthy(infoJson.like_count) ?? 0,
    channelName: firstTruthy(infoJson.channel, infoJson.uploader) ?? '',
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
  const limit = Math.min(500, Math.max(1, parseNonNegativeInt(readString(req.query.limit), COMMENTS_PAGE_SIZE)));

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
