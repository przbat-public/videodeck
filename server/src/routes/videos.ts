import express from 'express';
import { getVideos } from '../services/videoScanner';
import { getVideoFilePath } from '../utils/videoPathUtils';
import { getVideosFolderPath } from '../config';
import fs from 'fs/promises';
import path from 'path';

const router = express.Router();

// GET /api/videos/search?q={query}
router.get('/search', async (req, res) => {
  try {
    const query = req.query.q as string | undefined;

    const videos = getVideos(query);

    res.json({ videos });
  } catch (error) {
    console.error('Error searching videos:', error);
    res.status(500).json({
      error: 'Failed to search videos',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// GET /api/videos/list
router.get('/list', (req, res) => {
  try {
    const videos = getVideos();
    res.json({ videos });
  } catch (error) {
    console.error('Error listing videos:', error);
    res.status(500).json({
      error: 'Failed to list videos',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// GET /api/videos/file/:filename - Must be before /:baseName/details to avoid route conflicts
router.get('/file/:filename', async (req, res) => {
  try {
    const filename = req.params.filename;
    // Log the received filename for debugging
    if (process.env.NODE_ENV === 'development') {
      console.log('Received filename:', filename);
    }
    const filePath = getVideoFilePath(filename);

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

// GET /api/videos/:baseName/details
router.get('/:baseName/details', async (req, res) => {
  try {
    const baseName = req.params.baseName;
    const infoJsonPath = path.join(getVideosFolderPath(), `${baseName}.info.json`);

    // Check if file exists
    try {
      await fs.access(infoJsonPath);
    } catch {
      return res.status(404).json({ error: 'Video details not found' });
    }

    // Read and parse info.json
    let infoJson;
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

    // Reconstruct nested comment structure from flat array
    // Comments may be stored flat with 'parent' field instead of nested 'replies'
    const buildCommentTree = (comments: any[]): any[] => {
      if (!comments || comments.length === 0) return [];

      // Check if comments already have nested structure
      const hasNestedReplies = comments.some((c: any) => c.replies && Array.isArray(c.replies));
      if (hasNestedReplies) {
        // Sort root comments by like_count (descending - most likes first)
        const sorted = [...comments].sort((a, b) => {
          const likesA = a.like_count || 0;
          const likesB = b.like_count || 0;
          return likesB - likesA;
        });
        return sorted;
      }

      // Build tree from flat structure using 'parent' field
      const commentMap = new Map<string, any>();
      const rootComments: any[] = [];

      // First pass: create map and prepare comments
      comments.forEach((comment: any) => {
        const processed = {
          ...comment,
          replies: [] as any[],
          reply_count: 0,
        };
        commentMap.set(comment.id, processed);
      });

      // Second pass: build tree structure
      comments.forEach((comment: any) => {
        const processed = commentMap.get(comment.id)!;

        if (comment.parent === 'root' || !comment.parent) {
          rootComments.push(processed);
        } else {
          const parent = commentMap.get(comment.parent);
          if (parent) {
            parent.replies.push(processed);
            parent.reply_count = (parent.reply_count || 0) + 1;
          } else {
            // Orphaned reply, treat as root comment
            rootComments.push(processed);
          }
        }
      });

      // Sort root comments by like_count (descending - most likes first)
      rootComments.sort((a, b) => {
        const likesA = a.like_count || 0;
        const likesB = b.like_count || 0;
        return likesB - likesA;
      });

      return rootComments;
    };

    const comments = buildCommentTree(infoJson.comments || []);

    // Extract only needed fields (especially comments)
    // Use title from info.json as the main description/title
    const details = {
      title: infoJson.title || infoJson.fulltitle || '',
      description: infoJson.description || infoJson.title || infoJson.fulltitle || '', // Fallback to title if description missing
      uploadDate: infoJson.upload_date || '',
      duration: infoJson.duration_string || infoJson.duration || '',
      viewCount: infoJson.view_count || 0,
      likeCount: infoJson.like_count || 0,
      channel: infoJson.channel || infoJson.uploader || '',
      comments: comments,
      commentCount: infoJson.comment_count || comments.length || 0,
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
