import dotenv from 'dotenv';

dotenv.config();

const VIDEOS_FOLDER_PATH = process.env.VIDEOS_FOLDER_PATH as string;

if (!VIDEOS_FOLDER_PATH) {
  throw new Error('VIDEOS_FOLDER_PATH environment variable is required');
}

/**
 * Get all video folder paths from environment variable
 * Supports multiple paths separated by semicolon (;) or comma (,)
 * @returns Array of folder paths
 */
export function getVideosFolderPaths(): string[] {
  // Support both semicolon and comma as separators
  const paths = VIDEOS_FOLDER_PATH.split(/[;,]/)
    .map((path) => path.trim())
    .filter((path) => path.length > 0);

  if (paths.length === 0) {
    throw new Error('VIDEOS_FOLDER_PATH must contain at least one valid folder path');
  }

  return paths;
}
