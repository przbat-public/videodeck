import fs from 'node:fs/promises';
import path from 'node:path';
import { listVisibleFiles as sharedListVisibleFiles, writeJsonAtomic } from '../utils/fsUtils';
import { logger } from '../utils/logger';
import { runPool } from '../utils/runPool';

/**
 * Per-folder index of downloaded videos.
 *
 * Replaces the previous approach of reading and JSON-parsing every `.info.json`
 * in a folder on each request. The index is a small hidden file
 * (`.videos-index.json`) mapping YouTube video id -> { baseName, infoMtime, title }.
 * Alongside it we maintain yt-dlp's `archive.txt` (`youtube <id>` per line)
 * so yt-dlp itself never re-downloads a video whose title changed.
 *
 * Both files are derived from disk state and can be rebuilt at any time.
 */

export const INDEX_FILE = '.videos-index.json';
export const ARCHIVE_FILE = 'archive.txt';
const INFO_SUFFIX = '.info.json';
const VIDEO_EXTENSIONS = ['.mp4', '.mkv'];
const ID_HEAD_BYTES = 8 * 1024;
/** How many info.json files are inspected at once when (re)building the index */
const INDEX_REBUILD_CONCURRENCY = 8;

export interface FolderIndexEntry {
  /** File stem shared by the video and all its sidecar files */
  baseName: string;
  /** Video file name (with extension) */
  videoFile: string;
  /** ISO mtime of the .info.json — used as "last updated" */
  infoMtime: string;
  /** Video title from the info.json; absent in entries written before titles were recorded */
  title?: string;
}

export interface FolderIndex {
  version: 1;
  builtAt: string;
  entries: Record<string, FolderIndexEntry>;
}

export interface DownloadStatuses {
  downloadStatuses: Record<string, boolean>;
  lastUpdatedDates: Record<string, string>;
}

/**
 * Extract the top-level `id` from the beginning of a yt-dlp info.json.
 * yt-dlp writes `id` as the first key, so a cheap regex on the file head is
 * enough in practice; callers fall back to a full parse when this fails.
 */
export function extractVideoIdFromHead(head: string): string | null {
  const match = head.match(/^\s*\{\s*"id"\s*:\s*"([^"]+)"/);
  return match?.[1] ?? null;
}

/** The `title` string literal when it directly follows the leading `id` */
const TITLE_AFTER_ID_RE = /^\s*\{\s*"id"\s*:\s*"[^"]+"\s*,\s*"title"\s*:\s*("(?:[^"\\]|\\.)*")/;

/**
 * Extract the `title` yt-dlp writes right after `id`, unescaped. Null when it
 * is somewhere else or cut off by the head; the caller then records no title
 * rather than parsing a multi-megabyte file for it.
 */
export function extractTitleFromHead(head: string): string | null {
  const literal = head.match(TITLE_AFTER_ID_RE)?.[1];
  if (literal === undefined) {
    return null;
  }
  try {
    const title: unknown = JSON.parse(literal);
    return typeof title === 'string' ? title : null;
  } catch {
    return null;
  }
}

interface VideoHead {
  id: string;
  title?: string;
}

function toVideoHead(id: string, title: unknown): VideoHead {
  return typeof title === 'string' ? { id, title } : { id };
}

async function readVideoHead(infoPath: string): Promise<VideoHead | null> {
  const handle = await fs.open(infoPath, 'r');
  try {
    const buffer = Buffer.alloc(ID_HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, ID_HEAD_BYTES, 0);
    const head = buffer.subarray(0, bytesRead).toString('utf-8');
    const fromHead = extractVideoIdFromHead(head);
    if (fromHead) {
      return toVideoHead(fromHead, extractTitleFromHead(head));
    }
  } finally {
    await handle.close();
  }

  // Fallback: full parse (rare — e.g. reformatted files)
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(infoPath, 'utf-8'));
    if (typeof parsed !== 'object' || parsed === null || !('id' in parsed)) {
      return null;
    }
    if (typeof parsed.id !== 'string' || parsed.id.length === 0) {
      return null;
    }
    return toVideoHead(parsed.id, 'title' in parsed ? parsed.title : undefined);
  } catch {
    return null;
  }
}

function toIndexEntry(head: VideoHead, baseName: string, videoFile: string, infoMtime: Date): FolderIndexEntry {
  const entry: FolderIndexEntry = { baseName, videoFile, infoMtime: infoMtime.toISOString() };
  if (head.title !== undefined) {
    entry.title = head.title;
  }
  return entry;
}

function findVideoFile(baseName: string, files: Set<string>): string | undefined {
  for (const ext of VIDEO_EXTENSIONS) {
    const candidate = `${baseName}${ext}`;
    if (files.has(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

async function listVisibleFiles(folderPath: string): Promise<Set<string>> {
  const files = await sharedListVisibleFiles(folderPath);
  return new Set(files);
}

/** fs.stat result, or null when the file vanished mid-scan */
async function statOrNull(filePath: string): Promise<import('node:fs').Stats | null> {
  try {
    return await fs.stat(filePath);
  } catch {
    return null;
  }
}

async function readIndexFile(folderPath: string): Promise<FolderIndex | null> {
  try {
    const raw = await fs.readFile(path.join(folderPath, INDEX_FILE), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'version' in parsed &&
      parsed.version === 1 &&
      'entries' in parsed &&
      typeof parsed.entries === 'object' &&
      parsed.entries !== null
    ) {
      return parsed as FolderIndex;
    }
    return null;
  } catch {
    return null;
  }
}

async function saveIndex(folderPath: string, index: FolderIndex): Promise<void> {
  await writeJsonAtomic(folderPath, INDEX_FILE, index);
}

/**
 * Read ids recorded in yt-dlp's archive.txt (`<extractor> <id>` per line).
 */
export async function readArchiveIds(folderPath: string): Promise<Set<string>> {
  try {
    const raw = await fs.readFile(path.join(folderPath, ARCHIVE_FILE), 'utf-8');
    const ids = new Set<string>();
    for (const line of raw.split(/\r?\n/)) {
      const [, id] = line.trim().split(/\s+/);
      if (id) {
        ids.add(id);
      }
    }
    return ids;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return new Set();
    }
    throw error;
  }
}

async function writeArchive(folderPath: string, ids: Iterable<string>): Promise<void> {
  const lines = Array.from(ids)
    .sort()
    .map((id) => `youtube ${id}`);
  const content = lines.length > 0 ? `${lines.join('\n')}\n` : '';
  const archivePath = path.join(folderPath, ARCHIVE_FILE);
  await fs.writeFile(`${archivePath}.tmp`, content, 'utf-8');
  await fs.rename(`${archivePath}.tmp`, archivePath);
}

/**
 * Append ids to archive.txt that are not there yet (yt-dlp usually appends
 * itself during a download; this covers rebuilt indexes and edge cases).
 */
async function ensureArchiveHas(folderPath: string, ids: string[]): Promise<void> {
  if (ids.length === 0) {
    return;
  }
  const existing = await readArchiveIds(folderPath);
  const missing = ids.filter((id) => !existing.has(id));
  if (missing.length === 0) {
    return;
  }
  const lines = missing.map((id) => `youtube ${id}`).join('\n');
  const archivePath = path.join(folderPath, ARCHIVE_FILE);
  const prefix = existing.size > 0 ? await needsLeadingNewline(archivePath) : '';
  await fs.appendFile(archivePath, `${prefix}${lines}\n`, 'utf-8');
}

async function needsLeadingNewline(filePath: string): Promise<string> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return raw.length > 0 && !raw.endsWith('\n') ? '\n' : '';
  } catch {
    return '';
  }
}

/**
 * Scan the folder from scratch: every `.info.json` that has a matching video
 * file becomes an entry. Writes both the index and archive.txt (archive is
 * rewritten to reflect what is actually on disk).
 */
export async function rebuildIndex(folderPath: string): Promise<FolderIndex> {
  const files = await listVisibleFiles(folderPath);
  const entries: Record<string, FolderIndexEntry> = {};

  const infoFiles = [...files].filter((file) => file.endsWith(INFO_SUFFIX));
  // Reading the id head and stat of every info.json is I/O-bound; a small
  // pool finishes the folder scan several times faster than one by one.
  await runPool(infoFiles, INDEX_REBUILD_CONCURRENCY, async (file) => {
    const baseName = file.slice(0, -INFO_SUFFIX.length);
    const videoFile = findVideoFile(baseName, files);
    if (!videoFile) {
      return;
    }
    const infoPath = path.join(folderPath, file);
    try {
      const head = await readVideoHead(infoPath);
      if (!head) {
        return;
      }
      const stats = await fs.stat(infoPath);
      entries[head.id] = toIndexEntry(head, baseName, videoFile, stats.mtime);
    } catch (error) {
      logger.error(`folderIndex: skipping ${infoPath}:`, error);
    }
  });

  const index: FolderIndex = { version: 1, builtAt: new Date().toISOString(), entries };
  await saveIndex(folderPath, index);
  await writeArchive(folderPath, Object.keys(entries));
  return index;
}

/**
 * Load the index, rebuilding it when missing or unreadable.
 */
export async function loadIndex(folderPath: string): Promise<FolderIndex> {
  const existing = await readIndexFile(folderPath);
  if (existing) {
    return existing;
  }
  return rebuildIndex(folderPath);
}

export interface RefreshResult {
  index: FolderIndex;
  /** ids whose entries were added or updated */
  changed: string[];
  /** ids whose files vanished from disk (dropped from the index) */
  removed: string[];
}

/**
 * Incremental refresh after a yt-dlp run: only `.info.json` files modified at
 * or after `sinceMs` are inspected. Falls back to a full rebuild when the
 * index does not exist yet.
 *
 * Videos deleted from disk are dropped from the index, so they stop showing
 * as "downloaded". The sweep only runs when at least one info.json is
 * visible: an unmounted removable drive makes the folder look empty, and a
 * mass-wipe of the index would be worse than stale entries.
 */
export async function refreshIndex(folderPath: string, sinceMs: number): Promise<RefreshResult> {
  // A small tolerance covers filesystems with coarse mtime resolution (exFAT: 2 s)
  const threshold = sinceMs - 2000;
  return refreshEntries(folderPath, () => (_baseName, mtimeMs) => mtimeMs >= threshold);
}

/**
 * Add the videos the index has never seen, whatever their mtime. Downloads
 * made outside the queue (yt-dlp in a terminal) never trigger the post-job
 * refresh, and files moved in from another folder keep mtimes older than the
 * index, so refreshIndex would skip both. Same sweep and fallback as there.
 */
export async function indexUntrackedVideos(folderPath: string): Promise<RefreshResult> {
  return refreshEntries(folderPath, (index) => {
    const tracked = new Set(Object.values(index.entries).map((entry) => entry.baseName));
    return (baseName) => !tracked.has(baseName);
  });
}

/** Decides whether an info.json (by file stem and mtime) is re-read into the index */
type EntryFilter = (baseName: string, mtimeMs: number) => boolean;

async function refreshEntries(
  folderPath: string,
  filterFor: (index: FolderIndex) => EntryFilter,
): Promise<RefreshResult> {
  const existing = await readIndexFile(folderPath);
  if (!existing) {
    const index = await rebuildIndex(folderPath);
    return { index, changed: Object.keys(index.entries), removed: [] };
  }

  const files = await listVisibleFiles(folderPath);
  const changed = await collectChangedEntries(folderPath, files, existing, filterFor(existing));

  const removed = sweepDeletedEntries(existing, files);
  if (removed.length > 0) {
    logger.info(`folderIndex: dropped ${removed.length} videos deleted from disk in ${folderPath}`);
  }

  if (changed.length > 0 || removed.length > 0) {
    await saveIndex(folderPath, existing);
    await ensureArchiveHas(folderPath, changed);
  }
  return { index: existing, changed, removed };
}

/** Re-read the info.json files the filter selects and update the index in place */
async function collectChangedEntries(
  folderPath: string,
  files: Set<string>,
  existing: FolderIndex,
  isChanged: EntryFilter,
): Promise<string[]> {
  const changed: string[] = [];
  for (const file of files) {
    if (!file.endsWith(INFO_SUFFIX)) {
      continue;
    }
    const infoPath = path.join(folderPath, file);
    const baseName = file.slice(0, -INFO_SUFFIX.length);
    const stats = await statOrNull(infoPath);
    if (!stats || !isChanged(baseName, stats.mtimeMs)) {
      continue;
    }
    const videoFile = findVideoFile(baseName, files);
    if (!videoFile) {
      continue;
    }
    try {
      const head = await readVideoHead(infoPath);
      if (!head) {
        continue;
      }
      existing.entries[head.id] = toIndexEntry(head, baseName, videoFile, stats.mtime);
      changed.push(head.id);
    } catch (error) {
      logger.error(`folderIndex: skipping ${infoPath}:`, error);
    }
  }
  return changed;
}

/** Drop index entries whose info.json is gone (kept safe against unmounted drives) */
function sweepDeletedEntries(index: FolderIndex, files: Set<string>): string[] {
  let infoCount = 0;
  for (const file of files) {
    if (file.endsWith(INFO_SUFFIX)) {
      infoCount += 1;
    }
  }
  if (infoCount === 0) {
    return []; // empty folder: probably an unmounted drive — never mass-wipe
  }
  const removed: string[] = [];
  for (const [id, entry] of Object.entries(index.entries)) {
    if (!files.has(`${entry.baseName}${INFO_SUFFIX}`)) {
      delete index.entries[id];
      removed.push(id);
    }
  }
  return removed;
}

/**
 * Download status map for the UI, derived from the index.
 */
export async function getDownloadStatuses(folderPath: string): Promise<DownloadStatuses> {
  const index = await loadIndex(folderPath);
  const downloadStatuses: Record<string, boolean> = {};
  const lastUpdatedDates: Record<string, string> = {};
  for (const [id, entry] of Object.entries(index.entries)) {
    downloadStatuses[id] = true;
    lastUpdatedDates[id] = entry.infoMtime;
  }
  return { downloadStatuses, lastUpdatedDates };
}

export async function findEntryByVideoId(folderPath: string, videoId: string): Promise<FolderIndexEntry | null> {
  const index = await loadIndex(folderPath);
  return index.entries[videoId] ?? null;
}
