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
  const visibleFiles = files.filter(file => !file.startsWith('.'));
  
  const infoJsonFiles = visibleFiles.filter(file => file.endsWith('.info.json'));
  const videos: VideoInfo[] = [];
  for (const infoFile of infoJsonFiles) {
    // Remove .info.json extension to get base name for matching video/webp files
    // Example: "20230520_File.info.json" -> "20230520_File"
    const baseName = infoFile.replace(/\.info\.json$/, '');
    
    // Find corresponding .mp4 and .webp files (only from visible files)
    // Match by base name without extension
    const videoFile = visibleFiles.find(f => {
      const fBaseName = getBaseName(f);
      return fBaseName === baseName && f.endsWith('.mp4');
    });
    const thumbnailFile = visibleFiles.find(f => {
      const fBaseName = getBaseName(f);
      return fBaseName === baseName && f.endsWith('.webp');
    });

    if (videoFile && thumbnailFile) {
      try {
        const infoJsonPath = path.join(folderPath, infoFile);
        const infoJsonContent = await fs.readFile(infoJsonPath, 'utf-8');
        const infoJson = JSON.parse(infoJsonContent);
        
        // Use title from info.json as the description for search
        const title = infoJson.title || infoJson.fulltitle || '';
        const uploadDate = extractUploadDate(baseName);
        
        videos.push({
          baseName,
          name: title || baseName.replace(/_/g, ' ').replace(/^\d{8}_/, ''), // Use title, fallback to baseName
          description: title, // Use title for searching
          videoPath: videoFile,
          thumbnailPath: thumbnailFile,
          uploadDate,
        });
      } catch (error) {
        console.error(`Error reading info.json file ${infoFile}:`, error);
        // Continue with other files
      }
    }
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

  const filtered = videosCache.filter(video => 
    video.description.toLowerCase().includes(searchTerm) ||
    video.name.toLowerCase().includes(searchTerm)
  );

  // Return filtered results sorted by date (already sorted, but ensure consistency)
  return sortVideosByDate(filtered);
}

