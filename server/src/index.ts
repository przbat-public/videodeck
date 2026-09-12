import dotenv from 'dotenv';
import { validateVideosFolder } from './utils/videoPathUtils';
import { createApp } from './app';

dotenv.config();

const PORT = process.env.PORT || 3001;

// Start server
async function startServer() {
  try {
    await validateVideosFolder();
    console.log('Videos folder(s) validated');
    console.log('Server ready. Use GET /api/videos/refreshCache to index videos.');

    const app = createApp();
    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();
