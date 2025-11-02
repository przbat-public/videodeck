import fs from 'fs/promises';
import path from 'path';
import { getVideosFolderPath } from '../config';
import { VideoListItem } from '../types';

// Cache in memory
let videosCache: VideoListItem[] = [];
let isCacheLoaded = false;

/**
 * Check if stdout is a TTY (terminal) - important for concurrently compatibility
 * When running through concurrently, stdout may not be a TTY, so we use console.log instead
 */
const isStdoutTTY = process.stdout.isTTY;

/**
 * Log progress with support for both TTY and non-TTY environments (e.g., concurrently)
 */
function logProgress(loadedCount: number, totalFiles: number, percentage: string): void {
  const message = `Loaded: ${loadedCount}/${totalFiles} files (${percentage}%)`;

  if (isStdoutTTY) {
    // Terminal supports carriage return for overwriting same line
    process.stdout.write(`\r${message}`);
  } else {
    // Non-TTY (e.g., through concurrently) - use console.log
    // Only log every 10% or every 10 files to avoid spam
    if (
      totalFiles <= 10 ||
      loadedCount % Math.max(1, Math.floor(totalFiles / 10)) === 0 ||
      loadedCount === totalFiles
    ) {
      console.log(message);
    }
  }
}

/**
 * Extract base name from filename (remove extension)
 */
function getBaseName(filename: string): string {
  return path.parse(filename).name;
}

/**
 * Extract upload date from baseName (format: YYYYMMDD_title)
 * Returns date string in YYYYMMDD format or undefined if not found
 */
function extractUploadDate(baseName: string): string | undefined {
  const match = baseName.match(/^(\d{8})_/);
  return match ? match[1] : undefined;
}

export type SortOption = 
  | 'date-desc'
  | 'date-asc'
  | 'views-desc'
  | 'views-asc'
  | 'likes-desc'
  | 'likes-asc';

/**
 * Sort videos based on the provided sort option
 */
function sortVideos(videos: VideoListItem[], sortOption: SortOption = 'date-desc'): VideoListItem[] {
  const sorted = [...videos];

  switch (sortOption) {
    case 'date-desc':
      return sorted.sort((a, b) => {
        const dateA = a.uploadDate || '00000000';
        const dateB = b.uploadDate || '00000000';
        return dateB.localeCompare(dateA);
      });

    case 'date-asc':
      return sorted.sort((a, b) => {
        const dateA = a.uploadDate || '00000000';
        const dateB = b.uploadDate || '00000000';
        return dateA.localeCompare(dateB);
      });

    case 'views-desc':
      return sorted.sort((a, b) => {
        const viewsA = a.viewCount ?? 0;
        const viewsB = b.viewCount ?? 0;
        return viewsB - viewsA;
      });

    case 'views-asc':
      return sorted.sort((a, b) => {
        const viewsA = a.viewCount ?? 0;
        const viewsB = b.viewCount ?? 0;
        return viewsA - viewsB;
      });

    case 'likes-desc':
      return sorted.sort((a, b) => {
        const likesA = a.likeCount ?? 0;
        const likesB = b.likeCount ?? 0;
        return likesB - likesA;
      });

    case 'likes-asc':
      return sorted.sort((a, b) => {
        const likesA = a.likeCount ?? 0;
        const likesB = b.likeCount ?? 0;
        return likesA - likesB;
      });

    default:
      return sorted.sort((a, b) => {
        const dateA = a.uploadDate || '00000000';
        const dateB = b.uploadDate || '00000000';
        return dateB.localeCompare(dateA);
      });
  }
}

/**
 * Scan folder for .info.json files and extract video information
 */
async function scanVideosFromDisk(): Promise<VideoListItem[]> {
  const folderPath = getVideosFolderPath();
  const files = await fs.readdir(folderPath);

  // Filter out system files (starting with dot)
  const visibleFiles = files.filter((file) => !file.startsWith('.'));

  const infoJsonFiles = visibleFiles.filter((file) => file.endsWith('.info.json'));
  const totalFiles = infoJsonFiles.length;
  const videos: VideoListItem[] = [];
  let loadedCount = 0;

  if (totalFiles > 0) {
    console.log(`Scanning folder: ${totalFiles} .info.json files found`);
  }

  for (const infoFile of infoJsonFiles) {
    // Remove .info.json extension to get base name for matching video/webp files
    // Example: "20230520_File.info.json" -> "20230520_File"
    const baseName = infoFile.replace(/\.info\.json$/, '');

    // Find corresponding .mp4 and .webp files (only from visible files)
    // Match by base name without extension
    const videoFile = visibleFiles.find((f) => {
      const fBaseName = getBaseName(f);
      return fBaseName === baseName && f.endsWith('.mp4');
    });
    const thumbnailFile = visibleFiles.find((f) => {
      const fBaseName = getBaseName(f);
      return fBaseName === baseName && f.endsWith('.webp');
    });

    if (videoFile && thumbnailFile) {
      try {
        const infoJsonPath = path.join(folderPath, infoFile);
        const infoJsonContent = await fs.readFile(infoJsonPath, 'utf-8');
        loadedCount++;

        let infoJson;
        try {
          infoJson = JSON.parse(infoJsonContent);
        } catch (parseError) {
          if (parseError instanceof SyntaxError) {
            console.error(`Invalid JSON format in ${infoFile}:`, parseError.message);
          } else {
            console.error(`Error parsing JSON in ${infoFile}:`, parseError);
          }
          // Skip this file and continue with others
          const percentage = totalFiles > 0 ? ((loadedCount / totalFiles) * 100).toFixed(1) : '0.0';
          logProgress(loadedCount, totalFiles, percentage);
          continue;
        }

        const title = infoJson.title || infoJson.fulltitle || '';
        const description = infoJson.description || title;
        const uploadDate = infoJson.upload_date || extractUploadDate(baseName);
        const viewCount = infoJson.view_count;
        const likeCount = infoJson.like_count;

        videos.push({
          baseName,
          title: title || baseName.replace(/_/g, ' ').replace(/^\d{8}_/, ''),
          description,
          videoPath: videoFile,
          thumbnailPath: thumbnailFile,
          uploadDate,
          viewCount,
          likeCount,
        });
      } catch (error) {
        // Handle file read errors (not JSON parsing errors)
        console.error(`Error reading info.json file ${infoFile}:`, error);
        loadedCount++; // Count even files that failed to read
      }
    } else {
      // File .info.json doesn't have matching .mp4 or .webp, but count it as processed
      if (!videoFile && !thumbnailFile) {
        console.error(
          `\nSkipping ${infoFile}: missing both video (.mp4) and thumbnail (.webp) files`
        );
      } else if (!videoFile) {
        console.error(`\nSkipping ${infoFile}: missing video file (.mp4)`);
      } else if (!thumbnailFile) {
        console.error(`\nSkipping ${infoFile}: missing thumbnail file (.webp)`);
      }
      loadedCount++;
    }

    // Log progress after processing each file
    const percentage = totalFiles > 0 ? ((loadedCount / totalFiles) * 100).toFixed(1) : '0.0';
    logProgress(loadedCount, totalFiles, percentage);
  }

  // Add newline after progress is complete (only for TTY)
  if (totalFiles > 0 && isStdoutTTY) {
    process.stdout.write('\n');
  }

  // Sort by upload date (newest first) as default
  return sortVideos(videos, 'date-desc');
}

/**
 * Load videos into cache (called on server startup)
 */
export async function loadVideosCache(): Promise<void> {
  try {
    console.log('Loading videos cache...');
    videosCache = await scanVideosFromDisk();
    isCacheLoaded = true;
    console.log(`Videos cache loaded: ${videosCache.length} videos found`);
  } catch (error) {
    console.error('Failed to load videos cache:', error);
    throw error;
  }
}

/**
 * Refresh videos cache
 */
export async function refreshVideosCache(): Promise<void> {
  isCacheLoaded = false;
  await loadVideosCache();
}

/**
 * Search videos by query in title and description
 */
export function getVideos(query?: string, sortOption: SortOption = 'date-desc'): VideoListItem[] {
  if (!isCacheLoaded) {
    throw new Error('Videos cache not loaded. Call loadVideosCache() first.');
  }

  let results: VideoListItem[];

  if (!query || query.trim().length === 0) {
    results = videosCache;
  } else {
    const searchTerm = query.toLowerCase().trim();
    results = videosCache.filter(
      (video) =>
        video.title.toLowerCase().includes(searchTerm) ||
        (video.description && video.description.toLowerCase().includes(searchTerm))
    );
  }

  // Sort results according to the provided sort option
  return sortVideos(results, sortOption);
}
