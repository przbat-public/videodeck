import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs/promises';

dotenv.config();

const VIDEOS_FOLDER_PATH = process.env.VIDEOS_FOLDER_PATH as string;

if (!VIDEOS_FOLDER_PATH) {
  throw new Error('VIDEOS_FOLDER_PATH environment variable is required');
}

// Validate that the folder exists
export async function validateVideosFolder(): Promise<void> {
  try {
    const stats = await fs.stat(VIDEOS_FOLDER_PATH);
    if (!stats.isDirectory()) {
      throw new Error(`VIDEOS_FOLDER_PATH is not a directory: ${VIDEOS_FOLDER_PATH}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`VIDEOS_FOLDER_PATH does not exist: ${VIDEOS_FOLDER_PATH}`);
    }
    throw error;
  }
}

export function getVideosFolderPath(): string {
  return VIDEOS_FOLDER_PATH;
}

// Sanitize filename to prevent path traversal
export function sanitizeFilename(filename: string): string {
  // Remove any path separators and parent directory references
  const sanitized = path.basename(filename);
  
  // Prevent path traversal attempts
  if (sanitized.includes('..') || sanitized.includes('/') || sanitized.includes('\\')) {
    throw new Error('Invalid filename: path traversal detected');
  }
  
  // Ensure it's not empty
  if (!sanitized || sanitized.trim().length === 0) {
    throw new Error('Invalid filename: empty filename');
  }
  
  return sanitized;
}

// Get full path to a file in videos folder
export function getVideoFilePath(filename: string): string {
  const sanitized = sanitizeFilename(filename);
  const a =  path.join(VIDEOS_FOLDER_PATH, sanitized);
  console.log(a)
  return a;
}

