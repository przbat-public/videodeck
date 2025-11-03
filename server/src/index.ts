import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { validateVideosFolder } from './utils/videoPathUtils';
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
