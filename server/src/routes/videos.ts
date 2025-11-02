import express from 'express';
import { getVideos, SortOption } from '../services/videoScanner';
import { getVideoFilePath } from '../utils/videoPathUtils';
import { buildCommentTree } from '../utils/commentTreeUtils';
import { VideoInfoJson, VideoDetails } from '../types';
import fs from 'fs/promises';
import path from 'path';

const router = express.Router();

// GET /api/videos/search?q={query}&sort={sortOption}
router.get('/search', async (req, res) => {
  try {
    const query = req.query.q as string | undefined;
    const sort = (req.query.sort as SortOption) || 'date-desc';

    const videos = getVideos(query, sort);

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

// GET /api/videos/file/:filename - Must be before /:baseName routes to avoid route conflicts
router.get('/file/:filename', async (req, res) => {
  try {
    const filename = req.params.filename;
    // Log the received filename for debugging
    if (process.env.NODE_ENV === 'development') {
      console.log('Received filename:', filename);
    }

    // Try to find the video in cache to get its folder path
    const allVideos = getVideos();
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

// GET /api/videos/:baseName/details
router.get('/:baseName/details', async (req, res) => {
  try {
    const baseName = req.params.baseName;

    const allVideos = getVideos();
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
      comments: comments,
      commentCount: infoJson.comment_count || comments.length || 0,
      videoPath: video.videoPath,
      thumbnailPath: video.thumbnailPath,
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
