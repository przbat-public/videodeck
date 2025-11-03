import fs from 'fs/promises';
import path from 'path';
import { getVideosFolderPaths } from '../config';
import { VideoListItem, SortOption } from '../types';
import {
  indexVideo,
  searchVideos,
  deleteAllVideosFromFolder,
  createIndex,
  checkElasticsearchConnection,
} from './elasticsearchService';
import { buildCommentTree } from '../utils/commentTreeUtils';

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
 * Scan a single folder for .info.json files and extract video information
 * Indexes videos to Elasticsearch on the fly
 */
async function scanFolder(folderPath: string): Promise<void> {
  const files = await fs.readdir(folderPath);

  // Filter out system files (starting with dot)
  const visibleFiles = files.filter((file) => !file.startsWith('.'));

  const infoJsonFiles = visibleFiles.filter((file) => file.endsWith('.info.json'));

  await createIndex(folderPath);
  await deleteAllVideosFromFolder(folderPath);

  for (const infoFile of infoJsonFiles) {
    // Remove .info.json extension to get base name for matching video/webp files
    // Example: "20230520_File.info.json" -> "20230520_File"
    const baseName = infoFile.replace(/\.info\.json$/, '');

    // Find corresponding .mp4 and .webp files (only from visible files)
    // Match by base name without extension
    const videoFile = visibleFiles.find((f) => {
      const fBaseName = getBaseName(f);
      return (fBaseName === baseName && f.endsWith('.mp4')) || (fBaseName === baseName && f.endsWith('.mkv'));
    });

    const thumbnailFile = visibleFiles.find((f) => {
      const fBaseName = getBaseName(f);
      return (fBaseName === baseName && f.endsWith('.webp')) || (fBaseName === baseName && f.endsWith('.jpg'));
    });

    if (videoFile && thumbnailFile) {
      try {
        const infoJsonPath = path.join(folderPath, infoFile);
        const infoJsonContent = await fs.readFile(infoJsonPath, 'utf-8');

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
          continue;
        }

        const title = infoJson.title || infoJson.fulltitle || '';
        const description = infoJson.description || title;
        const uploadDate = infoJson.upload_date || extractUploadDate(baseName);
        const viewCount = infoJson.view_count;
        const likeCount = infoJson.like_count;
        const channelName = infoJson.channel || infoJson.uploader;

        const video: VideoListItem = {
          baseName,
          title: title || baseName.replace(/_/g, ' ').replace(/^\d{8}_/, ''),
          description,
          videoPath: videoFile,
          thumbnailPath: thumbnailFile,
          folderPath,
          uploadDate,
          viewCount,
          likeCount,
          channelName,
          comments: buildCommentTree(infoJson.comments || []),
        };

        try {
          await indexVideo(video);
        } catch (error) {
          console.error(`Failed to index video ${baseName}:`, error);
        }
      } catch (error) {
        // Handle file read errors (not JSON parsing errors)
        console.error(`Error reading info.json file ${infoFile}:`, error);
      }
    } else {
      // File .info.json doesn't have matching .mp4 (or .mkv) or .webp (or .jpg)
      if (!videoFile && !thumbnailFile) {
        console.error(
          `\nSkipping ${infoFile}: missing both video (.mp4 or .mkv) and thumbnail (.webp or .jpg) files`
        );
      } else if (!videoFile) {
        console.error(`\nSkipping ${infoFile}: missing video file (.mp4 or .mkv)`);
      } else if (!thumbnailFile) {
        console.error(`\nSkipping ${infoFile}: missing thumbnail file (.webp or .jpg)`);
      }
    }
  }
}

const scanVideosFromDisk = async (): Promise<void> => {
  const folderPaths = getVideosFolderPaths();

  for (const folderPath of folderPaths) {
    try {
      await scanFolder(folderPath);
    } catch (error) {
      console.error(`Error scanning folder ${folderPath}:`, error);
    }
  }
}

export async function loadVideosCache(): Promise<void> {
  try {
    // Check Elasticsearch connection
    const isConnected = await checkElasticsearchConnection();
    if (!isConnected) {
      throw new Error('Elasticsearch is not available. Please ensure Elasticsearch is running.');
    }

    console.log('Loading videos cache from disk...');
    await scanVideosFromDisk();
  } catch (error) {
    console.error('Failed to load videos cache:', error);
    throw error;
  }
}

export async function refreshVideosCache(): Promise<void> {
  await loadVideosCache();
}

export const getVideos = async (
  query?: string,
  sortOption: SortOption = 'date-desc'
): Promise<VideoListItem[]> => {
  // Use Elasticsearch for search and sorting
  // Videos are always available from Elasticsearch (indexed on the fly)
  return searchVideos(query, sortOption);
};
