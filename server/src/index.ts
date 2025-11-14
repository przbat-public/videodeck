import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import path from 'path';
import { exec } from 'child_process';
import { spawn } from 'child_process';
import { promisify } from 'util';
import { validateVideosFolder } from './utils/videoPathUtils';
import videosRouter from './routes/videos';
import { getVideosFolderPaths } from './config';

const execAsync = promisify(exec);

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/api/videos', videosRouter);

// Status endpoint
app.get('/api/status', async (req, res) => {
  try {
    const videosFolderPaths = getVideosFolderPaths();
    const folderConfigs: Record<string, { channelUrl?: string } | null> = {};

    // Load config for each folder
    for (const folderPath of videosFolderPaths) {
      const configPath = path.join(folderPath, 'config.json');
      try {
        const configContent = await fs.readFile(configPath, 'utf-8');
        const config = JSON.parse(configContent);
        folderConfigs[folderPath] = config;
      } catch (error) {
        // If file doesn't exist, set to null
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          folderConfigs[folderPath] = null;
        } else {
          // For other errors, log but continue
          console.error(`Error reading config for ${folderPath}:`, error);
          folderConfigs[folderPath] = null;
        }
      }
    }

    res.json({ 
      videosFolderPath: videosFolderPaths,
      folderConfigs,
      status: 'ok'
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to get status',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

app.put('/api/folder/config', async (req, res) => {
  try {
    const { folderPath, config } = req.body;
    
    if (!folderPath || typeof folderPath !== 'string') {
      return res.status(400).json({
        error: 'folderPath is required',
      });
    }

    if (!config || typeof config !== 'object') {
      return res.status(400).json({
        error: 'config object is required',
      });
    }

    // Validate that the folder path is in the allowed list
    const allowedPaths = getVideosFolderPaths();
    if (!allowedPaths.includes(folderPath)) {
      return res.status(403).json({
        error: 'Folder path is not in the allowed list',
      });
    }

    // Validate config structure
    if (config.channelUrl && typeof config.channelUrl !== 'string') {
      return res.status(400).json({
        error: 'channelUrl must be a string',
      });
    }

    const configPath = path.join(folderPath, 'config.json');
    
    // Ensure directory exists
    await fs.mkdir(folderPath, { recursive: true });
    
    // Write config file
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
    
    res.json({ success: true, config });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to save folder config',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// Check if list.json exists for a folder
app.get('/api/folder/list-exists', async (req, res) => {
  try {
    const { folderPath } = req.query;
    
    if (!folderPath || typeof folderPath !== 'string') {
      return res.status(400).json({
        error: 'folderPath is required',
      });
    }

    // Validate that the folder path is in the allowed list
    const allowedPaths = getVideosFolderPaths();
    if (!allowedPaths.includes(folderPath)) {
      return res.status(403).json({
        error: 'Folder path is not in the allowed list',
      });
    }

    const listPath = path.join(folderPath, 'list.json');
    
    try {
      await fs.access(listPath);
      res.json({ exists: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        res.json({ exists: false });
      } else {
        throw error;
      }
    }
  } catch (error) {
    res.status(500).json({
      error: 'Failed to check list.json',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// Get list.json content for a folder with download statuses
app.get('/api/folder/list', async (req, res) => {
  try {
    const { folderPath } = req.query;
    
    if (!folderPath || typeof folderPath !== 'string') {
      return res.status(400).json({
        error: 'folderPath is required',
      });
    }

    // Validate that the folder path is in the allowed list
    const allowedPaths = getVideosFolderPaths();
    if (!allowedPaths.includes(folderPath)) {
      return res.status(403).json({
        error: 'Folder path is not in the allowed list',
      });
    }

    const listPath = path.join(folderPath, 'list.json');
    
    try {
      const listContent = await fs.readFile(listPath, 'utf-8');
      const listData = JSON.parse(listContent);
      
      // Ensure it's an array
      if (!Array.isArray(listData)) {
        return res.status(400).json({
          error: 'list.json is not a valid array',
        });
      }
      
      // Extract only title, url and id from each video
      const videos = listData.map((video: { title?: string; url?: string; webpage_url?: string; id?: string }) => ({
        title: video.title || '',
        url: video.url || video.webpage_url || '',
        id: video.id || '',
      }));

      // Check download statuses for all videos at once
      const downloadStatuses: Record<string, boolean> = {};
      const lastUpdatedDates: Record<string, string> = {};
      
      try {
        const files = await fs.readdir(folderPath);
        const infoJsonFiles = files.filter((file) => file.endsWith('.info.json'));
        
        // Build a map of videoId -> downloaded status and last updated date
        for (const infoFile of infoJsonFiles) {
          try {
            const infoPath = path.join(folderPath, infoFile);
            const infoContent = await fs.readFile(infoPath, 'utf-8');
            const infoJson = JSON.parse(infoContent);
            
            if (infoJson.id) {
              // Check if corresponding video file exists
              const baseName = infoFile.replace(/\.info\.json$/, '');
              const videoFile = files.find((f) => {
                const base = path.parse(f).name;
                return base === baseName && (f.endsWith('.mp4') || f.endsWith('.mkv'));
              });
              
              if (videoFile) {
                downloadStatuses[infoJson.id] = true;
                
                // Get file modification time
                try {
                  const stats = await fs.stat(infoPath);
                  lastUpdatedDates[infoJson.id] = stats.mtime.toISOString();
                } catch (statError) {
                  // If stat fails, skip adding the date
                }
              }
            }
          } catch (err) {
            // Skip files that can't be read or parsed
            continue;
          }
        }
      } catch (error) {
        // If folder doesn't exist or can't be read, all videos are not downloaded
        // This is fine, we'll just return empty statuses
      }
      
      res.json({ videos, downloadStatuses, lastUpdatedDates });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return res.status(404).json({
          error: 'list.json not found',
        });
      }
      throw error;
    }
  } catch (error) {
    res.status(500).json({
      error: 'Failed to read list.json',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// Download playlist from YouTube channel
app.post('/api/folder/download-playlist', async (req, res) => {
  try {
    const { folderPath } = req.body;
    
    if (!folderPath || typeof folderPath !== 'string') {
      return res.status(400).json({
        error: 'folderPath is required',
      });
    }

    // Validate that the folder path is in the allowed list
    const allowedPaths = getVideosFolderPaths();
    if (!allowedPaths.includes(folderPath)) {
      return res.status(403).json({
        error: 'Folder path is not in the allowed list',
      });
    }

    // Load config.json to get channelUrl
    const configPath = path.join(folderPath, 'config.json');
    let config: { channelUrl?: string };
    
    try {
      const configContent = await fs.readFile(configPath, 'utf-8');
      config = JSON.parse(configContent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return res.status(404).json({
          error: 'config.json not found',
          message: 'Please create config.json file with channelUrl first',
        });
      }
      throw error;
    }

    if (!config.channelUrl || typeof config.channelUrl !== 'string') {
      return res.status(400).json({
        error: 'channelUrl is not configured',
        message: 'Please set channelUrl in config.json file',
      });
    }

    // Ensure directory exists
    await fs.mkdir(folderPath, { recursive: true });

    const listPath = path.join(folderPath, 'list.json');
    const channelUrl = config.channelUrl;
    const channelUrlWithVideos = channelUrl.endsWith('/videos') 
      ? channelUrl 
      : `${channelUrl}/videos`;

    // Execute yt-dlp command
    // yt-dlp outputs NDJSON (newline-delimited JSON) - each line is a separate JSON object
    // We need to collect them and save as a proper JSON array
    const command = `yt-dlp --flat-playlist -j "${channelUrlWithVideos}"`;
    
    try {
      const { stdout } = await execAsync(command, {
        cwd: folderPath,
        maxBuffer: 50 * 1024 * 1024, // 50MB buffer for large playlists
        shell: '/bin/sh',
      });
      
      // Process NDJSON output: split by newlines, parse each line as JSON, collect into array
      const jsonLines = stdout.trim().split('\n').filter(line => line.trim().length > 0);
      const jsonArray = jsonLines.map(line => {
        try {
          return JSON.parse(line);
        } catch (parseError) {
          console.error('Error parsing JSON line:', line.substring(0, 100));
          throw new Error(`Failed to parse JSON line: ${parseError instanceof Error ? parseError.message : 'Unknown error'}`);
        }
      });
      
      // Write as proper JSON array
      await fs.writeFile(listPath, JSON.stringify(jsonArray, null, 2), 'utf-8');
      
      res.json({ 
        success: true, 
        message: 'Playlist downloaded successfully',
        listPath,
        videoCount: jsonArray.length
      });
    } catch (execError) {
      const errorMessage = execError instanceof Error ? execError.message : 'Unknown error';
      console.error('Error executing yt-dlp:', errorMessage);
      res.status(500).json({
        error: 'Failed to download playlist',
        message: errorMessage,
      });
    }
  } catch (error) {
    res.status(500).json({
      error: 'Failed to download playlist',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// Check if a video is already downloaded
app.get('/api/folder/video-downloaded', async (req, res) => {
  try {
    const { folderPath, videoId } = req.query;
    
    if (!folderPath || typeof folderPath !== 'string') {
      return res.status(400).json({
        error: 'folderPath is required',
      });
    }

    if (!videoId || typeof videoId !== 'string') {
      return res.status(400).json({
        error: 'videoId is required',
      });
    }

    // Validate that the folder path is in the allowed list
    const allowedPaths = getVideosFolderPaths();
    if (!allowedPaths.includes(folderPath)) {
      return res.status(403).json({
        error: 'Folder path is not in the allowed list',
      });
    }

    try {
      const files = await fs.readdir(folderPath);
      const infoJsonFiles = files.filter((file) => file.endsWith('.info.json'));
      
      // Check each .info.json file to see if it contains the video ID
      for (const infoFile of infoJsonFiles) {
        try {
          const infoPath = path.join(folderPath, infoFile);
          const infoContent = await fs.readFile(infoPath, 'utf-8');
          const infoJson = JSON.parse(infoContent);
          
          if (infoJson.id === videoId) {
            // Check if corresponding video file exists
            const baseName = infoFile.replace(/\.info\.json$/, '');
            const videoFile = files.find((f) => {
              const base = path.parse(f).name;
              return base === baseName && (f.endsWith('.mp4') || f.endsWith('.mkv'));
            });
            
            if (videoFile) {
              return res.json({ downloaded: true });
            }
          }
        } catch (err) {
          // Skip files that can't be read or parsed
          continue;
        }
      }
      
      res.json({ downloaded: false });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return res.json({ downloaded: false });
      }
      throw error;
    }
  } catch (error) {
    res.status(500).json({
      error: 'Failed to check video download status',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// Download a single video with streaming output (SSE)
app.post('/api/folder/download-video', async (req, res) => {
  try {
    const { folderPath, videoUrl } = req.body;
    
    if (!folderPath || typeof folderPath !== 'string') {
      return res.status(400).json({
        error: 'folderPath is required',
      });
    }

    if (!videoUrl || typeof videoUrl !== 'string') {
      return res.status(400).json({
        error: 'videoUrl is required',
      });
    }

    // Validate that the folder path is in the allowed list
    const allowedPaths = getVideosFolderPaths();
    if (!allowedPaths.includes(folderPath)) {
      return res.status(403).json({
        error: 'Folder path is not in the allowed list',
      });
    }

    // Set up SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable buffering for nginx

    const sendEvent = (data: { type: string; message?: string; error?: string; done?: boolean }) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // Ensure directory exists
    await fs.mkdir(folderPath, { recursive: true });

    // Build yt-dlp command
    const command = `yt-dlp -c -i -o '%(upload_date)s_%(title)s.%(ext)s' --restrict-filenames -f "bestvideo[height<=1080]+bestaudio/best[height<=1080]" --merge-output-format mp4 --write-subs --write-auto-subs --sub-lang en --write-thumbnail --write-description --write-info-json --write-comments "${videoUrl}"`;

    sendEvent({ type: 'start', message: 'Starting download...' });

    // Use spawn instead of exec for streaming output
    const childProcess = spawn('yt-dlp', [
      '-c', '-i',
      '-o', '%(upload_date)s_%(title)s.%(ext)s',
      '--restrict-filenames',
      '-f', 'bestvideo[height<=1080]+bestaudio/best[height<=1080]',
      '--merge-output-format', 'mp4',
      '--write-subs', '--write-auto-subs', '--sub-lang', 'en',
      '--write-thumbnail', '--write-description', '--write-info-json', '--write-comments',
      videoUrl
    ], {
      cwd: folderPath,
      shell: false,
    });

    childProcess.stdout.on('data', (data: Buffer) => {
      sendEvent({ type: 'output', message: data.toString() });
    });

    childProcess.stderr.on('data', (data: Buffer) => {
      sendEvent({ type: 'output', message: data.toString() });
    });

    childProcess.on('close', (code: number) => {
      if (code === 0) {
        sendEvent({ type: 'done', message: 'Download completed successfully', done: true });
      } else {
        sendEvent({ type: 'error', error: `Process exited with code ${code}`, done: true });
      }
      res.end();
    });

    childProcess.on('error', (error: Error) => {
      sendEvent({ type: 'error', error: error.message, done: true });
      res.end();
    });

    // Handle client disconnect
    req.on('close', () => {
      childProcess.kill();
      res.end();
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to start video download',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Start server
async function startServer() {
  try {
    await validateVideosFolder();
    console.log('Videos folder(s) validated');
    console.log('Server ready. Use GET /api/videos/refreshCache to index videos.');

    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();
