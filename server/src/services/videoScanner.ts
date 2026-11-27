import fs from 'node:fs/promises';
import path from 'node:path';
import type { ReindexStatus, SortOption, VideoListItem } from '@videodeck/shared/api';
import { defaultSortFor } from '@videodeck/shared/search';
import { getVideosFolderPaths } from '../config';
import type { VideoInfoJson } from '../types';
import { listVisibleFiles, resolveContainedPath } from '../utils/fsUtils';
import { logger } from '../utils/logger';
import { stripUndefined } from '../utils/objectUtils';
import { runPool } from '../utils/runPool';
import { findThumbnailFile } from '../utils/thumbnails';
import { titleFromStem } from '../utils/videoStem';
import type { SearchOptions, VideoDocument } from './elasticsearchService';
import {
  bulkIndexDocuments,
  checkElasticsearchConnection,
  createIndexVersion,
  discardIndexVersion,
  estimateDocumentBytes,
  indexVideo,
  listCachedFolders,
  promoteIndexVersion,
  searchVideosWithTotal,
  toDocument,
} from './elasticsearchService';
import { MAX_INFO_JSON_BYTES, readVideoHead } from './folderIndex';
import { extractTextFromVttSubtitles } from './summaryService';

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

// ---------------------------------------------------------------------------
// Writes during a folder reindex
// ---------------------------------------------------------------------------

/**
 * Folder reindexes in flight, each settling once its new index version is
 * promoted or discarded. Until then the folder alias points at the version
 * the promotion deletes, so a document written through it would be lost.
 */
const reindexesInFlight = new Map<string, Promise<void>>();

/** Incremental writes in flight per folder, which a reindex lets land before it lists the folder */
const writesInFlight = new Map<string, Set<Promise<number>>>();

/** The reindex of this folder in flight, settling once its version is swapped in or dropped */
export function folderReindexInFlight(folderPath: string): Promise<void> | undefined {
  return reindexesInFlight.get(folderPath);
}

/** Keep a write in the folder's set until it settles; it never rejects, failures are logged */
function trackWrite(folderPath: string, write: Promise<number>): void {
  const writes = writesInFlight.get(folderPath) ?? new Set<Promise<number>>();
  writesInFlight.set(folderPath, writes);
  writes.add(write);
  const settled = (): void => {
    writes.delete(write);
    if (writes.size === 0 && writesInFlight.get(folderPath) === writes) {
      writesInFlight.delete(folderPath);
    }
  };
  void write.then(settled, settled);
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
 * Upload date from the stem prefix (YYYYMMDD_title, or YYYYMMDD_title_id for newer downloads)
 */
function extractUploadDate(baseName: string): string | undefined {
  return /^(\d{8})_/.exec(baseName)?.[1];
}

/** Sidecar files of one base name; `undefined` when the file is missing */
export interface FolderFiles {
  videoFile: string | undefined;
  /** By the rule the folder console counts with (utils/thumbnails.ts) */
  thumbnailFile: string | undefined;
  /** The English subtitle (summaries and the primary player track) */
  subtitleFile: string | undefined;
  /** Every subtitle file of the video, any language (`.en.vtt`, `.pl.vtt`, …) */
  subtitleFiles: string[];
}

/** Whether the file is a video the index can point at */
function isVideoFile(file: string): boolean {
  return file.endsWith('.mp4') || file.endsWith('.mkv');
}

/**
 * Locate the sidecar files that belong to a base name.
 */
export function findVideoFiles(baseName: string, visibleFiles: string[]): FolderFiles {
  const videoFile = visibleFiles.find((f) => isVideoFile(f) && getBaseName(f) === baseName);
  const thumbnailFile = findThumbnailFile(baseName, visibleFiles);

  const isSubtitle = (f: string) =>
    f.endsWith('.vtt') && (getBaseName(f) === baseName || getBaseName(f).startsWith(`${baseName}.`));
  const subtitleFiles = visibleFiles.filter(isSubtitle);
  // Prefer English for summaries; fall back to ANY subtitle language so a
  // Polish-only video is still summarizable (the old behavior 404'd on
  // every visit).
  const subtitleFile =
    visibleFiles.find((f) => f.endsWith('.en.vtt') && getBaseName(f) === `${baseName}.en`) ?? subtitleFiles[0];
  return { videoFile, thumbnailFile, subtitleFile, subtitleFiles };
}

/**
 * A folder's file names by every stem they could belong to: each name goes
 * under each prefix that ends right before one of its dots, in listing order.
 * Every file findVideoFiles accepts for a stem starts with `${stem}.` (the
 * media, the subtitles and the thumbnail rule of utils/thumbnails.ts), so the
 * group of a stem holds all its candidates in the order the listing had them,
 * which is the order ties are broken in. Grouping by path.parse(name).name
 * would lose `.en.vtt` and `.mp4_4.webp`, and grouping at the first dot would
 * lose every stem with a dot in it.
 */
export function groupFilesByStemPrefix(files: Iterable<string>): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const file of files) {
    for (let dot = file.indexOf('.'); dot !== -1; dot = file.indexOf('.', dot + 1)) {
      const prefix = file.slice(0, dot);
      const group = groups.get(prefix);
      if (group === undefined) {
        groups.set(prefix, [file]);
      } else {
        group.push(file);
      }
    }
  }
  return groups;
}

export type BuildResult = { status: 'ok'; video: VideoListItem } | { status: 'skipped'; reason: string };

/**
 * Searchable text of every subtitle file of the video (all languages), so
 * Polish subtitles are searchable too. A read failure only loses the
 * transcript, never the video.
 */
async function readTranscriptText(
  folderPath: string,
  baseName: string,
  subtitleFiles: string[],
): Promise<string | undefined> {
  if (subtitleFiles.length === 0) {
    return undefined;
  }
  const texts: string[] = [];
  for (const subtitleFile of subtitleFiles) {
    try {
      const realPath = await resolveContainedPath(folderPath, subtitleFile);
      const vtt = await fs.readFile(realPath, 'utf-8');
      const text = extractTextFromVttSubtitles(vtt);
      if (text.length > 0) {
        texts.push(text);
      }
    } catch (error) {
      logger.error(`Cannot read subtitles of ${baseName} for indexing:`, error);
    }
  }
  const joined = texts.join('\n\n');
  if (joined.length === 0) {
    return undefined;
  }
  return joined.length > MAX_TRANSCRIPT_CHARS ? joined.slice(0, MAX_TRANSCRIPT_CHARS) : joined;
}

/**
 * The info.json to index a video from. A file past MAX_INFO_JSON_BYTES
 * cannot be read as one string, so only its head is: the id and the title
 * yt-dlp writes first, which keep the video in search by its title, without
 * a description, counts or comments. Null when that head names no id.
 */
async function readInfoForIndex(realPath: string, baseName: string): Promise<VideoInfoJson | null> {
  const { size } = await fs.stat(realPath);
  if (size <= MAX_INFO_JSON_BYTES) {
    return JSON.parse(await fs.readFile(realPath, 'utf-8')) as VideoInfoJson;
  }
  const head = await readVideoHead(realPath);
  if (head === null) {
    return null;
  }
  logger.warn(
    `${baseName}: its info.json of ${size} bytes is past the longest string Node holds, so only its id and title are indexed`,
  );
  return { ...head };
}

/**
 * Read `<baseName>.info.json` and build the document for it. Returns a
 * `skipped` result (with reason) when the video file is missing or the JSON is
 * unreadable, so callers can count and log without throwing. A thumbnail is
 * no requirement: without one, `thumbnailPath` stays out of the document and
 * the client draws a placeholder.
 */
export async function buildVideoItem(
  folderPath: string,
  baseName: string,
  visibleFiles: string[],
): Promise<BuildResult> {
  const { videoFile, thumbnailFile, subtitleFile, subtitleFiles } = findVideoFiles(baseName, visibleFiles);

  if (!videoFile) {
    return { status: 'skipped', reason: `${baseName}: missing video file (.mp4 or .mkv)` };
  }

  let infoJson: VideoInfoJson | null;
  try {
    // Containment check: the info.json must resolve inside the folder even
    // if a symlink redirects the read elsewhere on the disk.
    const realPath = await resolveContainedPath(folderPath, `${baseName}.info.json`);
    infoJson = await readInfoForIndex(realPath, baseName);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { status: 'skipped', reason: `${baseName}: cannot read info.json (${detail})` };
  }
  if (infoJson === null) {
    return { status: 'skipped', reason: `${baseName}: info.json too large to read, and its head names no id` };
  }

  const title = infoJson.title || infoJson.fulltitle || '';
  const transcriptText = await readTranscriptText(folderPath, baseName, subtitleFiles);

  return {
    status: 'ok',
    video: stripUndefined<VideoListItem>({
      baseName,
      videoId: infoJson.id,
      title: title || titleFromStem(baseName, infoJson.id),
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
      transcriptText,
    }),
  };
}

// ---------------------------------------------------------------------------
// Full reindex of a folder (new index version + alias swap)
// ---------------------------------------------------------------------------

/**
 * Rebuild the folder's index from disk, holding the folder's incremental
 * writes until the new version is swapped in or dropped (see
 * indexVideosFromDisk).
 */
async function scanFolder(folderPath: string): Promise<void> {
  let settle: () => void = () => undefined;
  reindexesInFlight.set(
    folderPath,
    new Promise<void>((resolve) => {
      settle = resolve;
    }),
  );
  try {
    // On a folder with no alias yet, a write in flight creates and promotes a
    // version of its own, and that promotion deletes every other version, the
    // one this reindex writes included. With an alias the wait is harmless:
    // a write only starts once its files are on disk, so the listing below
    // includes them anyway.
    await Promise.allSettled(writesInFlight.get(folderPath) ?? []);
    await buildFolderVersion(folderPath);
  } finally {
    reindexesInFlight.delete(folderPath);
    settle();
  }
}

/**
 * Documents go into a fresh physical index; the alias is switched only when
 * everything was written, so search keeps serving the previous version
 * meanwhile.
 *
 * A folder whose videos were all there and none of which could be read, a
 * drive failing its reads mid-run, keeps the version it has: promoting the
 * empty one deleted it, and the folder vanished from search. A folder with no
 * video files at all, empty or sidecars only, has nothing to read and still
 * publishes its empty version.
 */
async function buildFolderVersion(folderPath: string): Promise<void> {
  const visibleFiles = await listVisibleFiles(folderPath);
  // Each stem looks its sidecars up in its own group: matched against the
  // whole listing, a folder of a few thousand videos took seconds
  const filesByStem = groupFilesByStemPrefix(visibleFiles);
  const baseNames = visibleFiles
    .filter((file) => file.endsWith('.info.json'))
    .map((file) => file.replace(/\.info\.json$/, ''));
  const videoStems = new Set(visibleFiles.filter(isVideoFile).map(getBaseName));
  const candidates = baseNames.filter((baseName) => videoStems.has(baseName)).length;
  let built = 0;

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
        const { indexed, skipped } = await bulkIndexDocuments(indexName, toSend, false);
        reindexStatus.indexed += indexed;
        reindexStatus.skipped += skipped;
      });
      flushing = run;
      return run;
    };

    // Reading info.json files (up to tens of MB each) is I/O-bound, so the
    // folder is scanned by a small pool instead of one file at a time.
    await runPool(baseNames, REINDEX_CONCURRENCY, async (baseName) => {
      const result = await buildVideoItem(folderPath, baseName, filesByStem.get(baseName) ?? []);
      if (result.status === 'ok') {
        built += 1;
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

    if (candidates > 0 && built === 0) {
      throw new Error(`none of its ${candidates} videos could be read, so the index it has stays`);
    }
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
      const lookup = await listCachedFolders(configured);
      folderPaths = configured.filter((folderPath) => !lookup.folders.has(folderPath));
      logger.info(
        `Reindex (onlyMissing): ${lookup.folders.size}/${configured.length} folders already have a cache and are skipped`,
      );
    }

    logger.info('Loading videos cache from disk...');
    await scanVideosFromDisk(folderPaths);
    logger.info(
      `Reindex finished: ${reindexStatus.indexed} indexed, ${reindexStatus.skipped} skipped, ${reindexStatus.errors.length} folder errors`,
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
 *
 * While the folder is being reindexed the write waits for the new version:
 * through the alias now, it would land in the version the swap deletes.
 */
export async function indexVideosFromDisk(folderPath: string, baseNames: string[]): Promise<number> {
  if (baseNames.length === 0) {
    return 0;
  }
  const reindex = reindexesInFlight.get(folderPath);
  if (reindex) {
    await reindex;
    return indexVideosFromDisk(folderPath, baseNames);
  }
  // Registered before the first await, so a reindex that starts later sees it
  const write = writeVideosFromDisk(folderPath, baseNames);
  trackWrite(folderPath, write);
  return write;
}

async function writeVideosFromDisk(folderPath: string, baseNames: string[]): Promise<number> {
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
  sortOption: SortOption = defaultSortFor(query),
  folderPaths?: string[],
  options?: SearchOptions,
): Promise<{ videos: VideoListItem[]; total: number }> => {
  return searchVideosWithTotal(query, sortOption, folderPaths, options);
};
