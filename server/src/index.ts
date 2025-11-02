import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { validateVideosFolder } from './utils/videoPathUtils';
import { loadVideosCache } from './services/videoScanner';
import videosRouter from './routes/videos';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/api/videos', videosRouter);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Start server
async function startServer() {
  try {
    // Validate videos folder on startup
    await validateVideosFolder();
    const folderPaths = process.env.VIDEOS_FOLDER_PATH?.split(/[;,]/).map(p => p.trim()).filter(p => p) || [];
    console.log(`Videos folder(s) validated: ${folderPaths.join(', ')}`);

    // Load videos cache into memory
    await loadVideosCache();

    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();
