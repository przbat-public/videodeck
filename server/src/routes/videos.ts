import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import OpenAI from 'openai';
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
import { getVideoFilePath } from '../utils/videoPathUtils';
import { buildCommentTree } from '../utils/commentTreeUtils';
import { stripUndefined } from '../utils/objectUtils';
import {
  getVideoByBaseName,
  getVideoByVideoId,
  getVideoByFilePath,
  getTotalVideoCount,
  recreateAllIndices,
} from '../services/elasticsearchService';
import { getFolderPathsForCategory, listCategories } from '../services/folderConfig';
import { OPENAI_API_KEY, getVideosFolderPaths } from '../config';
import { readString, sendError } from './http';
import type { NoParams, RouteHandler } from './http';
import { logger } from '../utils/logger';

// ---------------------------------------------------------------------------
// Subtitle text helpers (summary generation)
// ---------------------------------------------------------------------------

/**
 * Extracts plain text from VTT subtitle file by removing timestamps and metadata
 * This significantly reduces token count for OpenAI API calls
 */
function extractTextFromVttSubtitles(vttContent: string): string {
  const lines = vttContent.split('\n');
  const textLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim();

    // Skip empty lines
    if (!line) continue;

    // Skip WEBVTT header
    if (line === 'WEBVTT' || line.startsWith('WEBVTT')) continue;

    // Skip timestamp lines (format: 00:00:01.000 --> 00:00:04.000)
    if (line.includes('-->')) continue;

    // Skip cue identifiers (numeric lines that appear before timestamps)
    if (/^\d+$/.test(line)) continue;

    // Skip style/note blocks
    if (line.startsWith('NOTE') || line.startsWith('STYLE')) {
      // Skip until empty line
      while (i < lines.length - 1 && (lines[i + 1] ?? '').trim()) {
        i++;
      }
      continue;
    }

    // This is actual subtitle text
    textLines.push(line);
  }

  // Join lines with spaces, removing excessive whitespace
  // Multiple consecutive lines from same cue become one paragraph
  return textLines
    .join(' ')
    .replace(/<c>/g, ' ') // Replace opening <c> tags with spaces
    .replace(/<\/c>/g, ' ') // Replace closing </c> tags with spaces
    .trim();
}

/**
 * Estimates approximate token count (rough estimate: 1 token ≈ 4 characters for Polish text)
 * This is a conservative estimate to avoid exceeding API limits
 */
function estimateTokenCount(text: string): number {
  // Rough estimate: Polish text typically uses ~4 characters per token
  return Math.ceil(text.length / 4);
}

/**
 * Truncates text to fit within token limit, keeping complete sentences when possible
 * Leaves some buffer for system prompt and response tokens
 */
function truncateTextToTokenLimit(text: string, maxTokens: number): string {
  const estimatedTokens = estimateTokenCount(text);

  if (estimatedTokens <= maxTokens) {
    return text;
  }

  // Calculate max characters based on token limit
  const maxChars = maxTokens * 4;

  // Try to truncate at sentence boundary
  const truncated = text.substring(0, maxChars);
  const lastSentenceEnd = Math.max(
    truncated.lastIndexOf('.'),
    truncated.lastIndexOf('!'),
    truncated.lastIndexOf('?'),
    truncated.lastIndexOf('\n')
  );

  // If we found a sentence boundary in the last 20% of text, use it
  if (lastSentenceEnd > maxChars * 0.8) {
    return text.substring(0, lastSentenceEnd + 1).trim();
  }

  // Otherwise, just truncate at character limit
  return truncated.trim();
}

/** HTTP 429 from the OpenAI SDK (`APIError.status`) or a wrapped response */
function isRateLimitError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const { status, response } = error as { status?: unknown; response?: { status?: unknown } };
  return status === 429 || response?.status === 429;
}

// ---------------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------------

const SORT_OPTIONS: readonly SortOption[] = [
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

// GET /api/videos/refreshCache - Refresh/reindex videos cache
const startRefresh: RouteHandler<NoParams, AcceptedResponse | ReindexConflictResponse> = (
  _req,
  res
) => {
  try {
    if (isReindexRunning()) {
      res.status(409).json({
        error: 'Reindex already running',
        message: 'A reindex is already in progress',
        status: getReindexStatus(),
      });
      return;
    }

    logger.info('Cache refresh requested...');

    // Start the refresh process asynchronously (fire and forget)
    refreshVideosCache().catch((error: unknown) => {
      logger.error('Error refreshing cache in background:', error);
    });

    // Return immediately
    res.status(200).json({
      message: 'Cache refresh process started',
      status: 'ok',
    });
  } catch (error) {
    logger.error('Error starting cache refresh:', error);
    sendError(res, 500, 'Failed to start cache refresh', error);
  }
};

// POST /api/videos/recreateIndices - Recreate all Elasticsearch indices
const recreateIndices: RouteHandler<NoParams, AcceptedResponse> = (_req, res) => {
  try {
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
  } catch (error) {
    logger.error('Error starting indices recreation:', error);
    sendError(res, 500, 'Failed to start indices recreation', error);
  }
};

// GET /api/videos/search?q={query}&sort={sortOption}&category={category}
// The category is read from each folder's config.json and narrows the search
// to that category's folders; an unknown category matches no folder at all.
const search: RouteHandler<NoParams, SearchResponse> = async (req, res) => {
  try {
    const query = readString(req.query.q);
    const sort = parseSortOption(req.query.sort);
    const category = readString(req.query.category)?.trim();

    const folderPaths = category ? await getFolderPathsForCategory(category) : undefined;

    const videos = await getVideos(query, sort, folderPaths);
    const totalCount = await getTotalVideoCount(folderPaths);

    res.json({ videos, totalCount });
  } catch (error) {
    logger.error('Error searching videos:', error);
    sendError(res, 500, 'Failed to search videos', error);
  }
};

// GET /api/videos/categories
const getCategories: RouteHandler<NoParams, CategoriesResponse> = async (_req, res) => {
  try {
    res.json({ categories: await listCategories() });
  } catch (error) {
    logger.error('Error listing categories:', error);
    sendError(res, 500, 'Failed to list categories', error);
  }
};

// GET /api/videos/file/:filename?folder=<folderPath>
// The folder is taken from the `folder` query param (must be one of the
// configured folders); without it we look the file name up in Elasticsearch.
const serveFile: RouteHandler<{ filename: string }, never> = async (req, res) => {
  try {
    const { filename } = req.params;
    const folderParam = req.query.folder;

    let folderPath: string | undefined;
    if (folderParam !== undefined) {
      if (typeof folderParam !== 'string' || !getVideosFolderPaths().includes(folderParam)) {
        res.status(403).json({ error: 'Folder path is not in the allowed list' });
        return;
      }
      folderPath = folderParam;
    } else {
      try {
        const video = await getVideoByFilePath(filename);
        folderPath = video?.folderPath;
      } catch (lookupError) {
        logger.error('Error looking up file in Elasticsearch:', lookupError);
      }
    }

    // Falls back to the first configured folder when the file is not indexed
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
    }

    res.setHeader('Content-Type', contentType);
    res.sendFile(path.resolve(filePath));
  } catch (error) {
    logger.error('Error serving file:', error);
    sendError(res, 400, 'Failed to serve file', error);
  }
};

// Models in order of preference (higher TPM limits first)
const SUMMARY_MODELS = ['gpt-4o', 'gpt-4-turbo', 'gpt-4o-mini', 'gpt-4'];

// Reserve tokens for: system prompt (~50), user prompt (~100), response (2000), and buffer
// TPM limit is 30000, but we want to be safe with ~25000 tokens for input
const SUMMARY_MAX_INPUT_TOKENS = 25000;

// GET /api/videos/:identifier/summary - supports both baseName and videoId
const getSummary: RouteHandler<{ identifier: string }, VideoSummaryResponse> = async (req, res) => {
  try {
    const video = await findVideo(req.params.identifier);

    if (!video) {
      res.status(404).json({ error: 'Video not found' });
      return;
    }

    if (!video.subtitlePath) {
      res.status(404).json({ error: 'Subtitle not found' });
      return;
    }

    // Check if summary file already exists
    const summaryFilePath = path.join(video.folderPath, `${video.baseName}.summary.txt`);

    try {
      // Try to read existing summary
      const existingSummary = await fs.readFile(summaryFilePath, 'utf-8');
      if (existingSummary.trim()) {
        res.json({ summary: existingSummary.trim() });
        return;
      }
    } catch {
      // File doesn't exist, continue to generate new summary
    }

    if (!OPENAI_API_KEY) {
      res.status(500).json({
        error: 'OpenAI API key not configured',
        message: 'OPENAI_API_KEY environment variable is required',
      });
      return;
    }

    const subtitleFilePath = path.join(video.folderPath, video.subtitlePath);
    const subtitleFileContent = await fs.readFile(subtitleFilePath, 'utf-8');

    // Extract only text content from VTT, removing timestamps and metadata
    // This significantly reduces token count for OpenAI API
    let subtitleText = extractTextFromVttSubtitles(subtitleFileContent);

    const estimatedTokens = estimateTokenCount(subtitleText);
    const wasTruncated = estimatedTokens > SUMMARY_MAX_INPUT_TOKENS;

    if (wasTruncated) {
      logger.warn(
        `Subtitle text is too long (estimated ${estimatedTokens} tokens). Truncating to ${SUMMARY_MAX_INPUT_TOKENS} tokens.`
      );
      subtitleText = truncateTextToTokenLimit(subtitleText, SUMMARY_MAX_INPUT_TOKENS);
    }

    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

    let completion: OpenAI.Chat.Completions.ChatCompletion | undefined;
    let lastError: unknown;

    for (const model of SUMMARY_MODELS) {
      try {
        // Call OpenAI API to generate summary in Polish
        completion = await openai.chat.completions.create({
          model,
          messages: [
            {
              role: 'system',
              content:
                'Jesteś pomocnym asystentem, który tworzy zwięzłe podsumowania napisów filmowych w języku polskim.',
            },
            {
              role: 'user',
              content: `Przeanalizuj poniższe napisy filmowe i stwórz zwięzłe podsumowanie w języku polskim. Podsumowanie powinno zawierać główne tematy i kluczowe punkty omawiane w filmie. Nie umieszczaj na początku podsumowania o tym że jest to podsumowanie filmu.\n\nNapisy:\n${subtitleText}`,
            },
          ],
          temperature: 0.7,
          max_tokens: 2000,
        });
        break; // Success, exit loop
      } catch (error) {
        lastError = error;
        if (!isRateLimitError(error)) {
          // For other errors, rethrow immediately
          throw error;
        }
        logger.warn(`Rate limit hit for model ${model}, trying next model...`);
        if (model === SUMMARY_MODELS[SUMMARY_MODELS.length - 1]) {
          // Every model is rate limited — fail fast, the client decides when to retry
          const detail = error instanceof Error ? error.message : String(error);
          throw new Error(
            `Rate limit exceeded for all models. Please try again later. Original error: ${detail}`,
            { cause: error }
          );
        }
      }
    }

    if (!completion) {
      res.status(500).json({
        error: 'Failed to generate summary',
        message:
          lastError instanceof Error && lastError.message
            ? lastError.message
            : 'OpenAI API did not return a response',
      });
      return;
    }

    // Defensive `?.` on message: the API has returned choices without one
    const summary = completion.choices[0]?.message?.content;

    if (!summary) {
      res.status(500).json({
        error: 'Failed to generate summary',
        message: 'OpenAI API did not return a summary',
      });
      return;
    }

    // Save summary to disk for future use
    try {
      await fs.writeFile(summaryFilePath, summary, 'utf-8');
    } catch (writeError) {
      logger.error('Error saving summary to disk:', writeError);
      // Continue even if save fails - still return the summary
    }

    // `truncated` is only present when true
    res.json(
      stripUndefined<VideoSummaryResponse>({ summary, truncated: wasTruncated ? true : undefined })
    );
  } catch (error) {
    logger.error('Error getting video summary:', error);
    sendError(res, 500, 'Failed to get video summary', error);
  }
};

// GET /api/videos/:identifier/details - supports both baseName and videoId
const getDetails: RouteHandler<{ identifier: string }, VideoDetailsResponse> = async (req, res) => {
  try {
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
      // Re-throw file read errors to be caught by outer catch
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
  } catch (error) {
    logger.error('Error loading video details:', error);
    sendError(res, 500, 'Failed to load video details', error);
  }
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
