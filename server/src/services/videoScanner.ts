import fs from 'fs/promises';
import path from 'path';
import type { ReindexStatus, SortOption, VideoListItem } from '@shared/api';
import { getVideosFolderPaths } from '../config';
import type { VideoInfoJson } from '../types';
import { stripUndefined } from '../utils/objectUtils';
import { listVisibleFiles } from '../utils/fsUtils';
import { runPool } from '../utils/runPool';
import { logger } from '../utils/logger';
import { extractTextFromVttSubtitles } from './summaryService';
import {
  bulkIndexDocuments,
  checkElasticsearchConnection,
  createIndexVersion,
  discardIndexVersion,
  estimateDocumentBytes,
  indexVideo,
  listCachedFolders,
  promoteIndexVersion,
  searchVideos,
  toDocument,
} from './elasticsearchService';
import type { SearchOptions, VideoDocument } from './elasticsearchService';

/** Max documents per bulk request */
export const REINDEX_BATCH_SIZE = 50;
/**
 * Max (estimated) payload per bulk request. Comment-heavy channels have
 * multi-MB `commentsText` per video; Elasticsearch rejects requests above
 * `http.max_content_length` (100 MB) with an empty 413.
 */
export const REINDEX_BATCH_BYTES = 16 * 1024 * 1024;

/** How many info.json files are read/parsed at once during a folder scan */
export const REINDEX_CONCURRENCY = 4;

/** Transcripts are search-only; cap them so one video cannot bloat the index */
export const MAX_TRANSCRIPT_CHARS = 100_000;

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
  /** The English subtitle (summaries and the primary player track) */
  subtitleFile: string | undefined;
  /** Every subtitle file of the video, any language (`.en.vtt`, `.pl.vtt`, …) */
  subtitleFiles: string[];
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
  const isSubtitle = (f: string) =>
    f.endsWith('.vtt') &&
    (getBaseName(f) === baseName || getBaseName(f).startsWith(`${baseName}.`));
  const subtitleFiles = visibleFiles.filter(isSubtitle);
  const subtitleFile = visibleFiles.find(
    (f) => f.endsWith('.en.vtt') && getBaseName(f) === `${baseName}.en`
  );
  return { videoFile, thumbnailFile, subtitleFile, subtitleFiles };
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
  const { videoFile, thumbnailFile, subtitleFile, subtitleFiles } = findVideoFiles(
    baseName,
    visibleFiles
  );

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

  // Subtitle text is indexed for search ("find the video where he talks
  // about X") across EVERY language on disk, so Polish subtitles are
  // searchable too; a read failure only loses the transcript, never the video.
  let transcriptText: string | undefined;
  if (subtitleFiles.length > 0) {
    const texts: string[] = [];
    for (const subtitleFile of subtitleFiles) {
      try {
        const vtt = await fs.readFile(path.join(folderPath, subtitleFile), 'utf-8');
        const text = extractTextFromVttSubtitles(vtt);
        if (text.length > 0) {
          texts.push(text);
        }
      } catch (error) {
        logger.error(`Cannot read subtitles of ${baseName} for indexing:`, error);
      }
    }
    const joined = texts.join('\n\n');
    if (joined.length > 0) {
      transcriptText =
        joined.length > MAX_TRANSCRIPT_CHARS ? joined.slice(0, MAX_TRANSCRIPT_CHARS) : joined;
    }
  }

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
      transcriptText: transcriptText || undefined,
    }),
  };
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
    //
    // flush() grabs the pending batch synchronously (in the same turn as the
    // push that crossed the limit) and only the actual ES writes are
    // serialized — so every request carries exactly the batch seen at the
    // trigger, nothing is sent twice and nothing is lost.
    let batch: VideoDocument[] = [];
    let batchBytes = 0;
    let flushing: Promise<void> = Promise.resolve();
    const flush = (): Promise<void> => {
      const toSend = batch;
      batch = [];
      batchBytes = 0;
      if (toSend.length === 0) {
        return flushing;
      }
      const run = flushing.then(async () => {
        await bulkIndexDocuments(indexName, toSend, false);
        reindexStatus.indexed += toSend.length;
      });
      flushing = run;
      return run;
    };

    // Reading info.json files (up to tens of MB each) is I/O-bound, so the
    // folder is scanned by a small pool instead of one file at a time.
    await runPool(baseNames, REINDEX_CONCURRENCY, async (baseName) => {
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
        logger.error(`Skipping ${result.reason}`);
      }
      reindexStatus.filesDone += 1;
    });
    await flush();

    await promoteIndexVersion(folderPath, indexName);
  } catch (error) {
    await discardIndexVersion(indexName).catch((discardError) => {
      logger.error(`Failed to discard index ${indexName}:`, discardError);
    });
    throw error;
  }
}

async function scanVideosFromDisk(folderPaths: string[]): Promise<void> {
  reindexStatus.foldersTotal = folderPaths.length;

  for (const folderPath of folderPaths) {
    try {
      await scanFolder(folderPath);
    } catch (error) {
      const message = `Error scanning folder ${folderPath}: ${describeError(error)}`;
      logger.error(message, error);
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
 *
 * With `onlyMissing`, folders whose alias already exists in Elasticsearch
 * (their cache survived an earlier session — e.g. a previously plugged disk)
 * are skipped and the existing cache keeps serving searches. That is what
 * makes a disk swap cheap: only folders never indexed before are scanned.
 */
export async function loadVideosCache(options: { onlyMissing?: boolean } = {}): Promise<void> {
  if (reindexStatus.running) {
    throw new Error('Reindex is already running');
  }
  reindexStatus = { ...idleStatus(), running: true, startedAt: new Date().toISOString() };

  try {
    const isConnected = await checkElasticsearchConnection();
    if (!isConnected) {
      throw new Error('Elasticsearch is not available. Please ensure Elasticsearch is running.');
    }

    const configured = getVideosFolderPaths();
    let folderPaths = configured;
    if (options.onlyMissing) {
      const cached = await listCachedFolders(configured);
      folderPaths = configured.filter((folderPath) => !cached.has(folderPath));
      logger.info(
        `Reindex (onlyMissing): ${cached.size}/${configured.length} folders already have a cache and are skipped`
      );
    }

    logger.info('Loading videos cache from disk...');
    await scanVideosFromDisk(folderPaths);
    logger.info(
      `Reindex finished: ${reindexStatus.indexed} indexed, ${reindexStatus.skipped} skipped, ${reindexStatus.errors.length} folder errors`
    );
  } catch (error) {
    recordError(describeError(error));
    logger.error('Failed to load videos cache:', error);
    throw error;
  } finally {
    reindexStatus.running = false;
    delete reindexStatus.currentFolder;
    reindexStatus.finishedAt = new Date().toISOString();
  }
}

export async function refreshVideosCache(options: { onlyMissing?: boolean } = {}): Promise<void> {
  await loadVideosCache(options);
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
    logger.error(`Cannot list ${folderPath} for indexing:`, error);
    return 0;
  }
  for (const baseName of baseNames) {
    try {
      const result = await buildVideoItem(folderPath, baseName, visibleFiles);
      if (result.status !== 'ok') {
        logger.error(`Not indexing ${result.reason}`);
        continue;
      }
      await indexVideo(result.video);
      indexed += 1;
    } catch (error) {
      logger.error(`Failed to index ${baseName} from ${folderPath}:`, error);
    }
  }
  return indexed;
}

export const getVideos = async (
  query?: string,
  sortOption: SortOption = 'date-desc',
  folderPaths?: string[],
  options?: SearchOptions
): Promise<VideoListItem[]> => {
  return searchVideos(query, sortOption, folderPaths, options);
};
