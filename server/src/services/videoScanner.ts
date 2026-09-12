import fs from 'fs/promises';
import path from 'path';
import type { ReindexStatus, SortOption, VideoListItem } from '@shared/api';
import { getVideosFolderPaths } from '../config';
import type { VideoInfoJson } from '../types';
import { stripUndefined } from '../utils/objectUtils';
import {
  bulkIndexDocuments,
  checkElasticsearchConnection,
  createIndexVersion,
  discardIndexVersion,
  estimateDocumentBytes,
  indexVideo,
  promoteIndexVersion,
  searchVideos,
  toDocument,
} from './elasticsearchService';
import type { VideoDocument } from './elasticsearchService';

/** Max documents per bulk request */
export const REINDEX_BATCH_SIZE = 50;
/**
 * Max (estimated) payload per bulk request. Comment-heavy channels have
 * multi-MB `commentsText` per video; Elasticsearch rejects requests above
 * `http.max_content_length` (100 MB) with an empty 413.
 */
export const REINDEX_BATCH_BYTES = 16 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Reindex status (single process-wide job; shape: ReindexStatus in shared/api.ts)
// ---------------------------------------------------------------------------

const MAX_STATUS_ERRORS = 20;

const idleStatus = (): ReindexStatus => ({
  running: false,
  foldersDone: 0,
  foldersTotal: 0,
  filesDone: 0,
  filesTotal: 0,
  indexed: 0,
  skipped: 0,
  errors: [],
});

let reindexStatus: ReindexStatus = idleStatus();

export function getReindexStatus(): ReindexStatus {
  return { ...reindexStatus, errors: [...reindexStatus.errors] };
}

export function isReindexRunning(): boolean {
  return reindexStatus.running;
}

function recordError(message: string): void {
  reindexStatus.lastError = message;
  if (reindexStatus.errors.length < MAX_STATUS_ERRORS) {
    reindexStatus.errors.push(message);
  }
}

// ---------------------------------------------------------------------------
// Building documents from files
// ---------------------------------------------------------------------------

function getBaseName(filename: string): string {
  return path.parse(filename).name;
}

/**
 * Extract upload date from baseName (format: YYYYMMDD_title)
 */
function extractUploadDate(baseName: string): string | undefined {
  return /^(\d{8})_/.exec(baseName)?.[1];
}

/** Sidecar files of one base name; `undefined` when the file is missing */
export interface FolderFiles {
  videoFile: string | undefined;
  thumbnailFile: string | undefined;
  subtitleFile: string | undefined;
}

/**
 * Locate the sidecar files that belong to a base name.
 */
export function findVideoFiles(baseName: string, visibleFiles: string[]): FolderFiles {
  const videoFile = visibleFiles.find(
    (f) => (f.endsWith('.mp4') || f.endsWith('.mkv')) && getBaseName(f) === baseName
  );
  const thumbnailFile = visibleFiles.find(
    (f) => (f.endsWith('.webp') || f.endsWith('.jpg')) && getBaseName(f) === baseName
  );
  const subtitleFile = visibleFiles.find(
    (f) => f.endsWith('.en.vtt') && getBaseName(f) === `${baseName}.en`
  );
  return { videoFile, thumbnailFile, subtitleFile };
}

export type BuildResult =
  { status: 'ok'; video: VideoListItem } | { status: 'skipped'; reason: string };

/**
 * Read `<baseName>.info.json` and build the document for it. Returns a
 * `skipped` result (with reason) when the video/thumbnail is missing or the
 * JSON is unreadable, so callers can count and log without throwing.
 */
export async function buildVideoItem(
  folderPath: string,
  baseName: string,
  visibleFiles: string[]
): Promise<BuildResult> {
  const { videoFile, thumbnailFile, subtitleFile } = findVideoFiles(baseName, visibleFiles);

  if (!videoFile || !thumbnailFile) {
    const missing = [
      !videoFile ? 'video file (.mp4 or .mkv)' : null,
      !thumbnailFile ? 'thumbnail file (.webp or .jpg)' : null,
    ]
      .filter(Boolean)
      .join(' and ');
    return { status: 'skipped', reason: `${baseName}: missing ${missing}` };
  }

  const infoJsonPath = path.join(folderPath, `${baseName}.info.json`);
  let infoJson: VideoInfoJson;
  try {
    infoJson = JSON.parse(await fs.readFile(infoJsonPath, 'utf-8')) as VideoInfoJson;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { status: 'skipped', reason: `${baseName}: cannot read info.json (${detail})` };
  }

  const title = infoJson.title || infoJson.fulltitle || '';

  return {
    status: 'ok',
    video: stripUndefined<VideoListItem>({
      baseName,
      videoId: infoJson.id,
      title: title || baseName.replace(/^\d{8}_/, '').replace(/_/g, ' '),
      description: infoJson.description || title,
      videoPath: videoFile,
      thumbnailPath: thumbnailFile,
      folderPath,
      uploadDate: infoJson.upload_date || extractUploadDate(baseName),
      viewCount: infoJson.view_count,
      likeCount: infoJson.like_count,
      channelName: infoJson.channel || infoJson.uploader,
      comments: infoJson.comments || [],
      subtitlePath: subtitleFile,
    }),
  };
}

async function listVisibleFiles(folderPath: string): Promise<string[]> {
  const files = await fs.readdir(folderPath);
  return files.filter((file) => !file.startsWith('.'));
}

// ---------------------------------------------------------------------------
// Full reindex of a folder (new index version + alias swap)
// ---------------------------------------------------------------------------

/**
 * Rebuild the folder's index from disk. Documents go into a fresh physical
 * index; the alias is switched only when everything was written, so search
 * keeps serving the previous version meanwhile.
 */
async function scanFolder(folderPath: string): Promise<void> {
  const visibleFiles = await listVisibleFiles(folderPath);
  const baseNames = visibleFiles
    .filter((file) => file.endsWith('.info.json'))
    .map((file) => file.replace(/\.info\.json$/, ''));

  reindexStatus.currentFolder = folderPath;
  reindexStatus.filesDone = 0;
  reindexStatus.filesTotal = baseNames.length;

  const indexName = await createIndexVersion(folderPath);

  try {
    // Only flattened documents are kept between flushes: the parsed comment
    // arrays (the bulk of a big info.json) become garbage right away.
    let batch: VideoDocument[] = [];
    let batchBytes = 0;
    const flush = async () => {
      if (batch.length === 0) return;
      await bulkIndexDocuments(indexName, batch, false);
      reindexStatus.indexed += batch.length;
      batch = [];
      batchBytes = 0;
    };

    for (const baseName of baseNames) {
      const result = await buildVideoItem(folderPath, baseName, visibleFiles);
      if (result.status === 'ok') {
        const document = toDocument(result.video);
        batch.push(document);
        batchBytes += estimateDocumentBytes(document);
        if (batch.length >= REINDEX_BATCH_SIZE || batchBytes >= REINDEX_BATCH_BYTES) {
          await flush();
        }
      } else {
        reindexStatus.skipped += 1;
        console.error(`Skipping ${result.reason}`);
      }
      reindexStatus.filesDone += 1;
    }
    await flush();

    await promoteIndexVersion(folderPath, indexName);
  } catch (error) {
    await discardIndexVersion(indexName).catch((discardError) => {
      console.error(`Failed to discard index ${indexName}:`, discardError);
    });
    throw error;
  }
}

async function scanVideosFromDisk(): Promise<void> {
  const folderPaths = getVideosFolderPaths();
  reindexStatus.foldersTotal = folderPaths.length;

  for (const folderPath of folderPaths) {
    try {
      await scanFolder(folderPath);
    } catch (error) {
      const message = `Error scanning folder ${folderPath}: ${describeError(error)}`;
      console.error(message, error);
      recordError(message);
    }
    reindexStatus.foldersDone += 1;
  }
}

/**
 * Human-readable error, including the HTTP status of Elasticsearch
 * ResponseErrors (whose message is empty for e.g. 413 replies).
 */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const statusCode = (error as { meta?: { statusCode?: number } }).meta?.statusCode;
    const base = error.message || error.name || 'Error';
    return statusCode ? `${base} (HTTP ${statusCode})` : base;
  }
  return String(error);
}

/**
 * Rebuild the indices of all configured folders. Only one run at a time;
 * a second call while running is rejected.
 */
export async function loadVideosCache(): Promise<void> {
  if (reindexStatus.running) {
    throw new Error('Reindex is already running');
  }
  reindexStatus = { ...idleStatus(), running: true, startedAt: new Date().toISOString() };

  try {
    const isConnected = await checkElasticsearchConnection();
    if (!isConnected) {
      throw new Error('Elasticsearch is not available. Please ensure Elasticsearch is running.');
    }

    console.log('Loading videos cache from disk...');
    await scanVideosFromDisk();
    console.log(
      `Reindex finished: ${reindexStatus.indexed} indexed, ${reindexStatus.skipped} skipped, ${reindexStatus.errors.length} folder errors`
    );
  } catch (error) {
    recordError(describeError(error));
    console.error('Failed to load videos cache:', error);
    throw error;
  } finally {
    reindexStatus.running = false;
    delete reindexStatus.currentFolder;
    reindexStatus.finishedAt = new Date().toISOString();
  }
}

export async function refreshVideosCache(): Promise<void> {
  await loadVideosCache();
}

// ---------------------------------------------------------------------------
// Incremental indexing (after a download/update job)
// ---------------------------------------------------------------------------

/**
 * Index (or re-index) videos of one folder by base name, through the folder
 * alias. Failures are logged, never thrown — this runs after downloads and
 * must not fail them. Returns how many documents were written.
 */
export async function indexVideosFromDisk(
  folderPath: string,
  baseNames: string[]
): Promise<number> {
  if (baseNames.length === 0) {
    return 0;
  }
  let indexed = 0;
  let visibleFiles: string[];
  try {
    visibleFiles = await listVisibleFiles(folderPath);
  } catch (error) {
    console.error(`Cannot list ${folderPath} for indexing:`, error);
    return 0;
  }
  for (const baseName of baseNames) {
    try {
      const result = await buildVideoItem(folderPath, baseName, visibleFiles);
      if (result.status !== 'ok') {
        console.error(`Not indexing ${result.reason}`);
        continue;
      }
      await indexVideo(result.video);
      indexed += 1;
    } catch (error) {
      console.error(`Failed to index ${baseName} from ${folderPath}:`, error);
    }
  }
  return indexed;
}

export const getVideos = async (
  query?: string,
  sortOption: SortOption = 'date-desc',
  folderPaths?: string[]
): Promise<VideoListItem[]> => {
  return searchVideos(query, sortOption, folderPaths);
};
