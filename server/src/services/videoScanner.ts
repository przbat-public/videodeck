import fs from 'fs/promises';
import path from 'path';
import { getVideosFolderPath } from '../config';

export interface VideoInfo {
  baseName: string;
  name: string;
  description: string;
  videoPath: string;
  thumbnailPath: string;
  uploadDate?: string; // YYYYMMDD format from filename
}

// Cache in memory
let videosCache: VideoInfo[] = [];
let isCacheLoaded = false;

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

/**
 * Sort videos by upload date (newest first)
 */
function sortVideosByDate(videos: VideoInfo[]): VideoInfo[] {
  return [...videos].sort((a, b) => {
    const dateA = a.uploadDate || '00000000';
    const dateB = b.uploadDate || '00000000';
    // Sort descending (newest first)
    return dateB.localeCompare(dateA);
  });
}

/**
 * Scan folder for .info.json files and extract video information
 */
async function scanVideosFromDisk(): Promise<VideoInfo[]> {
  const folderPath = getVideosFolderPath();
  const files = await fs.readdir(folderPath);

  // Filter out system files (starting with dot)
  const visibleFiles = files.filter((file) => !file.startsWith('.'));

  const infoJsonFiles = visibleFiles.filter((file) => file.endsWith('.info.json'));
  const totalFiles = infoJsonFiles.length;
  const videos: VideoInfo[] = [];
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
          process.stdout.write(`\rLoaded: ${loadedCount}/${totalFiles} files (${percentage}%)`);
          continue;
        }

        const title = infoJson.title || infoJson.fulltitle || '';
        const description = infoJson.description || title;
        const uploadDate = infoJson.upload_date || extractUploadDate(baseName);

        videos.push({
          baseName,
          name: title || baseName.replace(/_/g, ' ').replace(/^\d{8}_/, ''), // Use title, fallback to baseName
          description,
          videoPath: videoFile,
          thumbnailPath: thumbnailFile,
          uploadDate,
        });
      } catch (error) {
        // Handle file read errors (not JSON parsing errors)
        console.error(`Error reading info.json file ${infoFile}:`, error);
        loadedCount++; // Count even files that failed to read
      }
    } else {
      // File .info.json doesn't have matching .mp4 or .webp, but count it as processed
      if (!videoFile && !thumbnailFile) {
        console.error(`\nSkipping ${infoFile}: missing both video (.mp4) and thumbnail (.webp) files`);
      } else if (!videoFile) {
        console.error(`\nSkipping ${infoFile}: missing video file (.mp4)`);
      } else if (!thumbnailFile) {
        console.error(`\nSkipping ${infoFile}: missing thumbnail file (.webp)`);
      }
      loadedCount++;
    }

    // Log progress after processing each file (overwrite same line)
    const percentage = totalFiles > 0 ? ((loadedCount / totalFiles) * 100).toFixed(1) : '0.0';
    process.stdout.write(`\rLoaded: ${loadedCount}/${totalFiles} files (${percentage}%)`);
  }

  // Add newline after progress is complete
  if (totalFiles > 0) {
    process.stdout.write('\n');
  }

  // Sort by upload date (newest first)
  return sortVideosByDate(videos);
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
 * Get all videos from cache
 */
export function getAllVideos(): VideoInfo[] {
  if (!isCacheLoaded) {
    throw new Error('Videos cache not loaded. Call loadVideosCache() first.');
  }
  return [...videosCache]; // Return a copy to prevent external modifications
}

/**
 * Search videos by query in description (uses cache)
 */
export function searchVideos(query: string): VideoInfo[] {
  if (!isCacheLoaded) {
    throw new Error('Videos cache not loaded. Call loadVideosCache() first.');
  }

  if (!query || query.trim().length === 0) {
    return [];
  }

  const searchTerm = query.toLowerCase().trim();

  const filtered = videosCache.filter(
    (video) =>
      video.description.toLowerCase().includes(searchTerm) ||
      video.name.toLowerCase().includes(searchTerm)
  );

  // Return filtered results sorted by date (already sorted, but ensure consistency)
  return sortVideosByDate(filtered);
}
