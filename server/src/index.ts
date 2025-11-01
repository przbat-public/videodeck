import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { validateVideosFolder } from './config';
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
    console.log(`Videos folder validated: ${process.env.VIDEOS_FOLDER_PATH}`);

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
