import express from 'express';
import { searchVideos, scanVideos } from '../services/videoScanner';
import { getVideoFilePath, validateVideosFolder } from '../config';
import fs from 'fs/promises';
import path from 'path';

const router = express.Router();

// GET /api/videos/search?q={query}
router.get('/search', async (req, res) => {
  try {
    await validateVideosFolder();
    const query = req.query.q as string | undefined;
    
    const videos = query 
      ? await searchVideos(query) 
      : await scanVideos();
    
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
router.get('/list', async (req, res) => {
  try {
    await validateVideosFolder();
    const videos = await scanVideos();
    res.json({ videos });
  } catch (error) {
    console.error('Error listing videos:', error);
    res.status(500).json({ 
      error: 'Failed to list videos',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// GET /api/videos/file/:filename
router.get('/file/:filename', async (req, res) => {
  try {
    await validateVideosFolder();
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

export default router;

