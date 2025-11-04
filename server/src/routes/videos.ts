import express from 'express';
import { getVideos, refreshVideosCache } from '../services/videoScanner';
import fs from 'fs/promises';
import path from 'path';
import OpenAI from 'openai';
import { SortOption, VideoInfoJson, VideoDetails } from '../types';
import { getVideoFilePath } from '../utils/videoPathUtils';
import { buildCommentTree } from '../utils/commentTreeUtils';
import { getTotalVideoCount, recreateAllIndices } from '../services/elasticsearchService';
import { OPENAI_API_KEY } from '../config';

/**
 * Extracts plain text from VTT subtitle file by removing timestamps and metadata
 * This significantly reduces token count for OpenAI API calls
 */
function extractTextFromVttSubtitles(vttContent: string): string {
  const lines = vttContent.split('\n');
  const textLines: string[] = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
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
      while (i < lines.length - 1 && lines[i + 1].trim()) {
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

const router = express.Router();

// GET /api/videos/refreshCache - Refresh/reindex videos cache
router.get('/refreshCache', async (req, res) => {
  try {
    console.log('Cache refresh requested...');
    
    // Start the refresh process asynchronously (fire and forget)
    refreshVideosCache().catch((error) => {
      console.error('Error refreshing cache in background:', error);
    });
    
    // Return immediately
    res.status(200).json({ 
      message: 'Cache refresh process started',
      status: 'ok'
    });
  } catch (error) {
    console.error('Error starting cache refresh:', error);
    res.status(500).json({
      error: 'Failed to start cache refresh',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// POST /api/videos/recreateIndices - Recreate all Elasticsearch indices
router.post('/recreateIndices', async (req, res) => {
  try {
    console.log('Recreate indices requested...');
    
    // Start the recreate process asynchronously (fire and forget)
    recreateAllIndices().catch((error) => {
      console.error('Error recreating indices in background:', error);
    });
    
    // Return immediately
    res.status(200).json({ 
      message: 'Indices recreation process started',
      status: 'ok'
    });
  } catch (error) {
    console.error('Error starting indices recreation:', error);
    res.status(500).json({
      error: 'Failed to start indices recreation',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// GET /api/videos/search?q={query}&sort={sortOption}
router.get('/search', async (req, res) => {
  try {
    const query = req.query.q as string | undefined;
    const sort = (req.query.sort as SortOption) || 'date-desc';

    const videos = await getVideos(query, sort);
    const totalCount = await getTotalVideoCount();

    res.json({ videos, totalCount });
  } catch (error) {
    console.error('Error searching videos:', error);
    res.status(500).json({
      error: 'Failed to search videos',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// GET /api/videos/file/:filename - Must be before /:baseName routes to avoid route conflicts
router.get('/file/:filename', async (req, res) => {
  try {
    const filename = req.params.filename;
    // Log the received filename for debugging
    if (process.env.NODE_ENV === 'development') {
      console.log('Received filename:', filename);
    }

    // Try to find the video in cache to get its folder path
    const allVideos = await getVideos();
    const video = allVideos.find(
      (video) => video.videoPath === filename || video.thumbnailPath === filename
    );

    const filePath = getVideoFilePath(filename, video?.folderPath);

    // Check if file exists
    try {
      await fs.access(filePath);
    } catch {
      return res.status(404).json({ error: 'File not found' });
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
    console.error('Error serving file:', error);
    res.status(400).json({
      error: 'Failed to serve file',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

router.get('/:baseName/summary', async (req, res) => {
  try {
    const baseName = req.params.baseName;

    const allVideos = await getVideos(baseName);
    const video = allVideos.find((v) => v.baseName === baseName);

    if (!video?.subtitlePath) {
      return res.status(404).json({ error: 'Subtitle not found' });
    }

    // Check if summary file already exists
    const summaryFilePath = path.join(video.folderPath, `${baseName}.summary.txt`);
    
    try {
      // Try to read existing summary
      const existingSummary = await fs.readFile(summaryFilePath, 'utf-8');
      if (existingSummary.trim()) {
        return res.json({ summary: existingSummary.trim() });
      }
    } catch {
      // File doesn't exist, continue to generate new summary
    }

    if (!OPENAI_API_KEY) {
      return res.status(500).json({
        error: 'OpenAI API key not configured',
        message: 'OPENAI_API_KEY environment variable is required',
      });
    }

    const subtitleFilePath = path.join(video.folderPath, video.subtitlePath);
    const subtitleFileContent = await fs.readFile(subtitleFilePath, 'utf-8');
    
    // Extract only text content from VTT, removing timestamps and metadata
    // This significantly reduces token count for OpenAI API
    let subtitleText = extractTextFromVttSubtitles(subtitleFileContent);

    // Truncate text to fit within token limits
    // Reserve tokens for: system prompt (~50), user prompt (~100), response (2000), and buffer
    // TPM limit is 30000, but we want to be safe with ~25000 tokens for input
    const maxInputTokens = 25000;
    const estimatedTokens = estimateTokenCount(subtitleText);
    const wasTruncated = estimatedTokens > maxInputTokens;
    
    if (wasTruncated) {
      console.warn(`Subtitle text is too long (estimated ${estimatedTokens} tokens). Truncating to ${maxInputTokens} tokens.`);
      subtitleText = truncateTextToTokenLimit(subtitleText, maxInputTokens);
    }

    // Initialize OpenAI client
    const openai = new OpenAI({
      apiKey: OPENAI_API_KEY,
    });

    // Try models in order of preference (higher TPM limits first)
    // Note: gpt-4.1 might be a custom model name, so we include it as fallback
    const models = ['gpt-4o', 'gpt-4-turbo', 'gpt-4o-mini', 'gpt-4'];
    let completion;
    let lastError: Error | null = null;

    for (const model of models) {
      try {
        // Call OpenAI API to generate summary in Polish
        completion = await openai.chat.completions.create({
          model,
          messages: [
            {
              role: 'system',
              content: 'Jesteś pomocnym asystentem, który tworzy zwięzłe podsumowania napisów filmowych w języku polskim.',
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
      } catch (error: any) {
        lastError = error;
        // If it's a 429 error (rate limit), try next model
        // If it's another error, also try next model
        if (error?.status === 429 || error?.response?.status === 429) {
          console.warn(`Rate limit hit for model ${model}, trying next model...`);
          if (model === models[models.length - 1]) {
            // Last model failed, wait a bit and retry
            await new Promise(resolve => setTimeout(resolve, 60000)); // Wait 60 seconds
            throw new Error(`Rate limit exceeded for all models. Please try again later. Original error: ${error.message}`);
          }
          continue;
        }
        // For other errors, rethrow immediately
        throw error;
      }
    }

    if (!completion) {
      return res.status(500).json({
        error: 'Failed to generate summary',
        message: lastError?.message || 'OpenAI API did not return a response',
      });
    }

    const summary = completion.choices[0]?.message?.content;

    if (!summary) {
      return res.status(500).json({
        error: 'Failed to generate summary',
        message: 'OpenAI API did not return a summary',
      });
    }

    // Save summary to disk for future use
    try {
      await fs.writeFile(summaryFilePath, summary, 'utf-8');
    } catch (writeError) {
      console.error('Error saving summary to disk:', writeError);
      // Continue even if save fails - still return the summary
    }

    res.json({ 
      summary,
      truncated: wasTruncated ? true : undefined, // Only include if true
    });
  } catch (error) {
    console.error('Error getting video summary:', error);
    res.status(500).json({
      error: 'Failed to get video summary',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// GET /api/videos/:baseName/details
router.get('/:baseName/details', async (req, res) => {
  try {
    const baseName = req.params.baseName;

    const allVideos = await getVideos(baseName);
    const video = allVideos.find((v) => v.baseName === baseName);

    if (!video) {
      return res.status(404).json({ error: 'Video not found' });
    }

    // Use the folder path from the video item
    const infoJsonPath = path.join(video.folderPath, `${baseName}.info.json`);

    // Check if video file details exist
    try {
      await fs.access(infoJsonPath);
    } catch {
      return res.status(404).json({ error: 'Video details not found' });
    }

    // Read and parse info.json
    let infoJson: VideoInfoJson;
    try {
      const infoJsonContent = await fs.readFile(infoJsonPath, 'utf-8');
      infoJson = JSON.parse(infoJsonContent);
    } catch (parseError) {
      console.error(`Error reading or parsing info.json file ${infoJsonPath}:`, parseError);
      if (parseError instanceof SyntaxError) {
        return res.status(500).json({
          error: 'Invalid JSON format in video metadata',
          message: 'The video metadata file is corrupted or invalid',
        });
      }
      // Re-throw file read errors to be caught by outer catch
      throw parseError;
    }

    const comments = buildCommentTree(infoJson.comments || []);

    const details: VideoDetails = {
      title: infoJson.title || infoJson.fulltitle || '',
      description: infoJson.description || infoJson.title || infoJson.fulltitle || '',
      uploadDate: infoJson.upload_date || '',
      duration: infoJson.duration_string || (infoJson.duration ? String(infoJson.duration) : ''),
      viewCount: infoJson.view_count || 0,
      likeCount: infoJson.like_count || 0,
      channelName: infoJson.channel || infoJson.uploader || '',
      comments: buildCommentTree(infoJson.comments || []),
      commentCount: infoJson.comment_count || comments.length || 0,
      videoPath: video.videoPath,
      thumbnailPath: video.thumbnailPath,
      subtitlePath: video.subtitlePath,
    };

    res.json({ details });
  } catch (error) {
    console.error('Error loading video details:', error);
    res.status(500).json({
      error: 'Failed to load video details',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;
