import dotenv from 'dotenv';

dotenv.config();

const VIDEOS_FOLDER_PATH = process.env.VIDEOS_FOLDER_PATH as string;

if (!VIDEOS_FOLDER_PATH) {
  throw new Error('VIDEOS_FOLDER_PATH environment variable is required');
}

export function getVideosFolderPath(): string {
  return VIDEOS_FOLDER_PATH;
}
