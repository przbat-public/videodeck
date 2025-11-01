import express from 'express';
import { searchVideos, getAllVideos } from '../services/videoScanner';
import { getVideoFilePath, getVideosFolderPath } from '../config';
import fs from 'fs/promises';
import path from 'path';

const router = express.Router();

// GET /api/videos/search?q={query}
router.get('/search', async (req, res) => {
  try {
    const query = req.query.q as string | undefined;
    
    const videos = query 
      ? searchVideos(query) 
      : getAllVideos();
    
    res.json({ videos });
  } catch (error) {
    console.error('Error searching videos:', error);
    res.status(500).json({ 
      error: 'Failed to search videos',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// GET /api/videos/list
router.get('/list', (req, res) => {
  try {
    const videos = getAllVideos();
    res.json({ videos });
  } catch (error) {
    console.error('Error listing videos:', error);
    res.status(500).json({ 
      error: 'Failed to list videos',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// GET /api/videos/file/:filename - Must be before /:baseName/details to avoid route conflicts
router.get('/file/:filename', async (req, res) => {
  try {
    const filename = req.params.filename;
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
      message: error instanceof Error ? error.message : 'Unknown error'
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
    const infoJsonContent = await fs.readFile(infoJsonPath, 'utf-8');
    const infoJson = JSON.parse(infoJsonContent);
    
    // Extract only needed fields (especially comments)
    const details = {
      title: infoJson.title || infoJson.fulltitle || '',
      description: infoJson.description || '',
      uploadDate: infoJson.upload_date || '',
      duration: infoJson.duration_string || infoJson.duration || '',
      viewCount: infoJson.view_count || 0,
      likeCount: infoJson.like_count || 0,
      channel: infoJson.channel || infoJson.uploader || '',
      comments: infoJson.comments || [],
      commentCount: infoJson.comment_count || 0,
    };

    res.json({ details });
  } catch (error) {
    console.error('Error loading video details:', error);
    res.status(500).json({ 
      error: 'Failed to load video details',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;

