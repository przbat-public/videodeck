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
    console.error(
      `Path traversal detected in filename: ${filename} (decoded: ${decoded}, sanitized: ${sanitized})`
    );
    throw new Error('Invalid filename: path traversal detected');
  }

  // Check for path traversal patterns: "." or ".." as the entire filename only
  // These are directory references, not valid filenames
  // Allowed: "file.", "file..webp", "name...ext" - dots are part of the filename
  // Blocked: "." or ".." as the complete filename (directory references)
  if (sanitized === '.' || sanitized === '..') {
    console.error(
      `Path traversal detected in filename: ${filename} (decoded: ${decoded}, sanitized: ${sanitized})`
    );
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
