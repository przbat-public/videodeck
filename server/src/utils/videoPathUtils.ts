import path from 'path';
import fs from 'fs/promises';
import { getVideosFolderPaths } from '../config';

// Validate that all folders exist
export async function validateVideosFolder(): Promise<void> {
  const folderPaths = getVideosFolderPaths();
  const errors: string[] = [];

  for (const folderPath of folderPaths) {
    try {
      const stats = await fs.stat(folderPath);
      if (!stats.isDirectory()) {
        errors.push(`${folderPath} is not a directory`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        errors.push(`${folderPath} does not exist`);
      } else {
        errors.push(
          `Error accessing ${folderPath}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`VIDEOS_FOLDER_PATH validation failed:\n${errors.join('\n')}`);
  }
}

// Sanitize filename to prevent path traversal
export function sanitizeFilename(filename: string): string {
  // Express already URL-decodes route parameters. basename() strips any
  // leftover separators, so only an encoded separator could survive — and
  // basename removes those too.
  const sanitized = path.basename(filename);

  // Only explicit directory references are rejected: "." and ".." as the
  // whole name. Names with dots inside ("file..webp") are regular files.
  if (sanitized === '.' || sanitized === '..') {
    throw new Error('Invalid filename: path traversal detected');
  }

  if (!sanitized || sanitized.trim().length === 0) {
    throw new Error('Invalid filename: empty filename');
  }

  return sanitized;
}

// Get full path to a file in videos folder
export function getVideoFilePath(filename: string, folderPath?: string): string {
  const sanitized = sanitizeFilename(filename);

  if (folderPath) {
    // Use provided folder path (from video item)
    return path.join(folderPath, sanitized);
  }

  // Fallback: the first configured folder (kept for files that are not indexed)
  const [firstFolder] = getVideosFolderPaths();
  if (firstFolder === undefined) {
    throw new Error('No video folders configured');
  }
  return path.join(firstFolder, sanitized);
}
