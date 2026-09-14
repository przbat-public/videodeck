import fs from 'fs/promises';
import path from 'path';
import { logger } from '../utils/logger';

/**
 * Per-folder index of downloaded videos.
 *
 * Replaces the previous approach of reading and JSON-parsing every `.info.json`
 * in a folder on each request. The index is a small hidden file
 * (`.videos-index.json`) mapping YouTube video id -> { baseName, infoMtime }.
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

export interface FolderIndexEntry {
  /** File stem shared by the video and all its sidecar files */
  baseName: string;
  /** Video file name (with extension) */
  videoFile: string;
  /** ISO mtime of the .info.json — used as "last updated" */
  infoMtime: string;
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

async function readVideoId(infoPath: string): Promise<string | null> {
  const handle = await fs.open(infoPath, 'r');
  try {
    const buffer = Buffer.alloc(ID_HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, ID_HEAD_BYTES, 0);
    const fromHead = extractVideoIdFromHead(buffer.subarray(0, bytesRead).toString('utf-8'));
    if (fromHead) {
      return fromHead;
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
    return typeof parsed.id === 'string' && parsed.id.length > 0 ? parsed.id : null;
  } catch {
    return null;
  }
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
  const files = await fs.readdir(folderPath);
  return new Set(files.filter((f) => !f.startsWith('.')));
}

async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  const tmp = `${filePath}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
  await fs.rename(tmp, filePath);
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
  await writeJsonAtomic(path.join(folderPath, INDEX_FILE), index);
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

  for (const file of files) {
    if (!file.endsWith(INFO_SUFFIX)) {
      continue;
    }
    const baseName = file.slice(0, -INFO_SUFFIX.length);
    const videoFile = findVideoFile(baseName, files);
    if (!videoFile) {
      continue;
    }
    const infoPath = path.join(folderPath, file);
    try {
      const id = await readVideoId(infoPath);
      if (!id) {
        continue;
      }
      const stats = await fs.stat(infoPath);
      entries[id] = { baseName, videoFile, infoMtime: stats.mtime.toISOString() };
    } catch (error) {
      logger.error(`folderIndex: skipping ${infoPath}:`, error);
    }
  }

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
}

/**
 * Incremental refresh after a yt-dlp run: only `.info.json` files modified at
 * or after `sinceMs` are inspected. Falls back to a full rebuild when the
 * index does not exist yet.
 */
export async function refreshIndex(folderPath: string, sinceMs: number): Promise<RefreshResult> {
  const existing = await readIndexFile(folderPath);
  if (!existing) {
    const index = await rebuildIndex(folderPath);
    return { index, changed: Object.keys(index.entries) };
  }

  const files = await listVisibleFiles(folderPath);
  const changed: string[] = [];
  // small tolerance for filesystems with coarse mtime resolution (exFAT: 2s)
  const threshold = sinceMs - 2000;

  for (const file of files) {
    if (!file.endsWith(INFO_SUFFIX)) {
      continue;
    }
    const infoPath = path.join(folderPath, file);
    let stats;
    try {
      stats = await fs.stat(infoPath);
    } catch {
      continue;
    }
    if (stats.mtimeMs < threshold) {
      continue;
    }
    const baseName = file.slice(0, -INFO_SUFFIX.length);
    const videoFile = findVideoFile(baseName, files);
    if (!videoFile) {
      continue;
    }
    try {
      const id = await readVideoId(infoPath);
      if (!id) {
        continue;
      }
      existing.entries[id] = { baseName, videoFile, infoMtime: stats.mtime.toISOString() };
      changed.push(id);
    } catch (error) {
      logger.error(`folderIndex: skipping ${infoPath}:`, error);
    }
  }

  if (changed.length > 0) {
    await saveIndex(folderPath, existing);
    await ensureArchiveHas(folderPath, changed);
  }
  return { index: existing, changed };
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

export async function findEntryByVideoId(
  folderPath: string,
  videoId: string
): Promise<FolderIndexEntry | null> {
  const index = await loadIndex(folderPath);
  return index.entries[videoId] ?? null;
}
