import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  AcceptedResponse,
  ApiError,
  CategoriesResponse,
  ChannelsResponse,
  CommentsResponse,
  CommentWithReplies,
  RecreateIndicesStatus,
  ReindexConflictResponse,
  ReindexStatus,
  SearchResponse,
  SortOption,
  SubtitleTrack,
  VideoDetails,
  VideoDetailsResponse,
  VideoListItem,
  VideoSummaryResponse,
} from '@videodeck/shared/api';
import { COMMENTS_PAGE_SIZE } from '@videodeck/shared/schemas';
import type { Response } from 'express';
import express from 'express';
import { getVideosFolderPaths } from '../config';
import { loadCommentTree } from '../services/commentStore';
import type { SearchOptions } from '../services/elasticsearchService';
import {
  getRecreateIndicesStatus,
  getVideoByBaseName,
  getVideoByFilePath,
  getVideoByVideoId,
  isRecreateIndicesRunning,
  listChannelNames,
  recreateAllIndices,
  SEARCH_DEFAULT_LIMIT,
} from '../services/elasticsearchService';
import { getFolderPathsForCategory, listCategories } from '../services/folderConfig';
import { generateSummary, SummaryUnavailableError } from '../services/summaryService';
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
function parseSortOption(value: unknown): SortOption {
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

/**
 * Hard cap for `?offset=`: beyond this Elasticsearch dies on
 * `max_result_window` (from+size > 10000) and every request becomes a 500.
 */
const MAX_OFFSET = 10_000;

/** `?offset=` for search/comments: clamped so a huge offset cannot 500 ES */
function parseOffset(value: string | undefined): number {
  return Math.min(parseNonNegativeInt(value, 0), MAX_OFFSET);
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

// POST /api/videos/refreshCache - Refresh/reindex videos cache.
// ?onlyMissing=1 reindexes only the folders whose cache does not exist in
// Elasticsearch yet, so a swapped-in disk with a cache from a previous
// session is searched immediately and only new folders are scanned.
// POST (not GET) because starting a reindex is a side effect: a GET could be
// triggered by a cross-site navigation in browsers that do not send
// Sec-Fetch-Site.
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
  res.status(202).json({
    message: 'Cache refresh process started',
    status: 'ok',
  });
};

// GET /api/videos/recreateIndices/status - Progress of the running/last index recreation
const getRecreateIndicesStatusHandler: RouteHandler<NoParams, RecreateIndicesStatus> = (_req, res) => {
  res.json(getRecreateIndicesStatus());
};

// POST /api/videos/recreateIndices - Recreate all Elasticsearch indices
const recreateIndices: RouteHandler<NoParams, AcceptedResponse | ApiError> = (_req, res) => {
  if (isRecreateIndicesRunning()) {
    res.status(409).json({
      error: 'Index recreation already running',
      message: 'Index recreation is already in progress',
    });
    return;
  }
  logger.info('Recreate indices requested...');

  // Start the recreate process asynchronously (fire and forget); the client
  // polls /api/videos/recreateIndices/status until it finishes.
  recreateAllIndices().catch((error: unknown) => {
    logger.error('Error recreating indices in background:', error);
  });

  // Return immediately
  res.status(202).json({
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
  const offset = parseOffset(readString(req.query.offset));
  const limit = parseNonNegativeInt(readString(req.query.limit), SEARCH_DEFAULT_LIMIT);
  const channel = readString(req.query.channel)?.trim() || undefined;

  const folderPaths = category ? await getFolderPathsForCategory(category) : undefined;

  const options = stripUndefined<SearchOptions>({ offset, limit, channel });
  const { videos, total: totalCount } = await getVideos(query, sort, folderPaths, options);

  res.json({ videos, totalCount });
};

// GET /api/videos/categories
const getCategories: RouteHandler<NoParams, CategoriesResponse> = async (_req, res) => {
  res.json({ categories: await listCategories() });
};

// GET /api/videos/channels - distinct channel names for the filter UI, plus
// the channel of every folder for the console's search link
const getChannelNames: RouteHandler<NoParams, ChannelsResponse> = async (_req, res) => {
  res.json(await listChannelNames());
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
  const normalizedFolder = normalizeFolderPath(folderPath);
  const allowedFolders = getVideosFolderPaths().map(normalizeFolderPath);
  if (!allowedFolders.includes(normalizedFolder)) {
    res.status(403).json({ error: `Folder path is not in the allowed list: ${folderPath}` });
    return;
  }

  // Containment check next to the file sinks: resolve the request to an
  // absolute path and verify it stays inside the allowed folder, so a
  // filename can never escape the folder even if the sanitizer missed a
  // traversal. getVideoFilePath already rejects `..` segments — this is the
  // defense-in-depth layer the reads below depend on.
  const filePath = path.resolve(getVideoFilePath(filename, folderPath));
  const folderRoot = `${normalizedFolder}${path.sep}`;
  if (!filePath.startsWith(folderRoot)) {
    res.status(403).json({ error: 'File is outside the video folder' });
    return;
  }

  // Resolve symlinks and re-check containment: a symlink planted inside the
  // folder must not make the server read or serve files outside it. The
  // resolved path is used for every read below (no access→sendFile TOCTOU).
  let realPath: string;
  try {
    const [realFile, realFolder] = await Promise.all([fs.realpath(filePath), fs.realpath(normalizedFolder)]);
    const realRoot = realFolder.endsWith(path.sep) ? realFolder : `${realFolder}${path.sep}`;
    if (!realFile.startsWith(realRoot)) {
      res.status(403).json({ error: 'File is outside the video folder' });
      return;
    }
    realPath = realFile;
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
      const vtt = await fs.readFile(realPath, 'utf-8');
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
  res.sendFile(realPath);
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
  // the service; failures bubble up to the error handler middleware — except
  // the "no key configured" case, which gets a distinct, actionable 503.
  let summary: string;
  let truncated: boolean;
  try {
    ({ summary, truncated } = await generateSummary({
      folderPath: video.folderPath,
      baseName: video.baseName,
      subtitlePath: video.subtitlePath,
    }));
  } catch (error) {
    if (error instanceof SummaryUnavailableError) {
      res.status(503).json({ error: 'Summaries are disabled — set OPENAI_API_KEY on the server' });
      return;
    }
    throw error;
  }

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

  const details = buildDetails(infoJson, video, comments, commentCount, subtitles);

  res.json({ details });
};

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

  const offset = parseOffset(readString(req.query.offset));
  const limit = Math.min(500, Math.max(1, parseNonNegativeInt(readString(req.query.limit), COMMENTS_PAGE_SIZE)));

  res.json({ comments: tree.slice(offset, offset + limit), totalCount: tree.length, offset });
};

// ---------------------------------------------------------------------------
// Routes (order matters: /file/:filename before the /:identifier routes)
// ---------------------------------------------------------------------------

const router = express.Router();

router.get('/refreshCache/status', getRefreshStatus);
router.post('/refreshCache', startRefresh);
router.get('/recreateIndices/status', getRecreateIndicesStatusHandler);
router.post('/recreateIndices', recreateIndices);
router.get('/search', search);
router.get('/categories', getCategories);
router.get('/channels', getChannelNames);
router.get('/file/:filename', serveFile);
router.get('/:identifier/summary', getSummary);
router.get('/:identifier/comments', getComments);
router.get('/:identifier/details', getDetails);

export default router;
