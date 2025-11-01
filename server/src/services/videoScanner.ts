import fs from 'fs/promises';
import path from 'path';
import { getVideosFolderPath } from '../config';

export interface VideoInfo {
  baseName: string;
  name: string;
  description: string;
  videoPath: string;
  thumbnailPath: string;
}

/**
 * Extract base name from filename (remove extension)
 */
function getBaseName(filename: string): string {
  return path.parse(filename).name;
}

/**
 * Scan folder for .description files and extract video information
 */
export async function scanVideos(): Promise<VideoInfo[]> {
  const folderPath = getVideosFolderPath();
  const files = await fs.readdir(folderPath);
  
  const descriptionFiles = files.filter(file => file.endsWith('.description'));
  const videos: VideoInfo[] = [];

  for (const descFile of descriptionFiles) {
    const baseName = getBaseName(descFile);
    
    // Find corresponding .mp4 and .webp files
    const videoFile = files.find(f => getBaseName(f) === baseName && f.endsWith('.mp4'));
    const thumbnailFile = files.find(f => getBaseName(f) === baseName && f.endsWith('.webp'));

    if (videoFile && thumbnailFile) {
      try {
        const descriptionPath = path.join(folderPath, descFile);
        const description = await fs.readFile(descriptionPath, 'utf-8');
        
        videos.push({
          baseName,
          name: baseName.replace(/_/g, ' ').replace(/^\d{8}_/, ''), // Remove date prefix if present
          description: description.trim(),
          videoPath: videoFile,
          thumbnailPath: thumbnailFile,
        });
      } catch (error) {
        console.error(`Error reading description file ${descFile}:`, error);
        // Continue with other files
      }
    }
  }

  return videos;
}

/**
 * Search videos by query in description
 */
export async function searchVideos(query: string): Promise<VideoInfo[]> {
  if (!query || query.trim().length === 0) {
    return scanVideos();
  }

  const allVideos = await scanVideos();
  const searchTerm = query.toLowerCase().trim();

  return allVideos.filter(video => 
    video.description.toLowerCase().includes(searchTerm) ||
    video.name.toLowerCase().includes(searchTerm)
  );
}

