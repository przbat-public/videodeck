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
  // Express automatically URL-decodes route parameters, but handle edge cases
  // Check if the filename contains URL-encoded characters and decode if needed
  let decoded = filename;
  if (filename.includes('%')) {
    try {
      decoded = decodeURIComponent(filename);
    } catch {
      // If decoding fails, use original (might already be decoded or malformed)
      decoded = filename;
    }
  }
  
  // Remove any path separators and parent directory references
  // Use path.basename to extract only the filename, removing any path components
  const sanitized = path.basename(decoded);
  
  // Prevent path traversal attempts
  // After path.basename(), we only have the filename without any path components.
  // We need to block only explicit directory references (".", "..") and path separators.
  // 
  // Important: Names ending with dots (like "file." or "file..webp") are allowed
  // because after path.basename() they're just regular filenames without path components.
  // Only block when the entire filename is exactly "." or ".." (directory references).
  
  // Check for path separators (shouldn't exist after basename, but double-check)
  if (sanitized.includes('/') || sanitized.includes('\\')) {
    console.error(`Path traversal detected in filename: ${filename} (decoded: ${decoded}, sanitized: ${sanitized})`);
    throw new Error('Invalid filename: path traversal detected');
  }
  
  // Check for path traversal patterns: "." or ".." as the entire filename only
  // These are directory references, not valid filenames
  // Allowed: "file.", "file..webp", "name...ext" - dots are part of the filename
  // Blocked: "." or ".." as the complete filename (directory references)
  if (sanitized === '.' || sanitized === '..') {
    console.error(`Path traversal detected in filename: ${filename} (decoded: ${decoded}, sanitized: ${sanitized})`);
    throw new Error('Invalid filename: path traversal detected');
  }
  
  // Ensure it's not empty
  if (!sanitized || sanitized.trim().length === 0) {
    console.error(`Empty filename detected: ${filename} (decoded: ${decoded})`);
    throw new Error('Invalid filename: empty filename');
  }
  
  return sanitized;
}

// Get full path to a file in videos folder
export function getVideoFilePath(filename: string): string {
  const sanitized = sanitizeFilename(filename);
  return path.join(VIDEOS_FOLDER_PATH, sanitized);
}

