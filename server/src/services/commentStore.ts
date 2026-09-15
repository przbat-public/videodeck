import fs from 'node:fs/promises';
import path from 'node:path';
import type { CommentWithReplies } from '@videodeck/shared/api';
import type { VideoInfoJson } from '../types';
import { buildCommentTree } from '../utils/commentTreeUtils';
import { resolveContainedPath } from '../utils/fsUtils';

/**
 * Parsed comment trees with a cache keyed by the info.json mtime. Videos
 * with hundreds of thousands of comments produce info.json files of hundreds
 * of megabytes: the details endpoint and the paginated comments endpoint
 * must not re-parse them on every request — and once a download rewrites the
 * file, the mtime changes and the next read gets the fresh tree.
 */

/** Oldest entries are dropped past this many cached trees */
const CACHE_MAX_ENTRIES = 50;

interface CacheEntry {
  mtimeMs: number;
  tree: CommentWithReplies[];
}

const cache = new Map<string, CacheEntry>();

export function invalidateCommentCache(): void {
  cache.clear();
}

/**
 * The top-level comment tree of a video, or null when its info.json does
 * not exist. Other read errors propagate (the caller maps them to 500).
 */
export async function loadCommentTree(folderPath: string, baseName: string): Promise<CommentWithReplies[] | null> {
  const filePath = path.join(folderPath, `${baseName}.info.json`);
  const key = `${folderPath}\n${baseName}`;

  let mtimeMs: number;
  try {
    mtimeMs = (await fs.stat(filePath)).mtimeMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }

  const cached = cache.get(key);
  if (cached !== undefined && cached.mtimeMs === mtimeMs) {
    return cached.tree;
  }

  // Containment check: the info.json must resolve inside the folder even if
  // a symlink tries to redirect the read elsewhere on the disk.
  const realPath = await resolveContainedPath(folderPath, `${baseName}.info.json`);
  const infoJson = JSON.parse(await fs.readFile(realPath, 'utf-8')) as VideoInfoJson;
  const tree = buildCommentTree(infoJson.comments || []);
  cache.set(key, { mtimeMs, tree });
  if (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) {
      cache.delete(oldest);
    }
  }
  return tree;
}
