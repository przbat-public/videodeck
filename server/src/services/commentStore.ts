import fs from 'node:fs/promises';
import path from 'node:path';
import v8 from 'node:v8';
import type { CommentWithReplies } from '@videodeck/shared/api';
import type { VideoInfoJson } from '../types';
import { buildCommentTree } from '../utils/commentTreeUtils';
import { resolveContainedPath } from '../utils/fsUtils';
import { createSingleFlight } from '../utils/singleFlight';

/**
 * Parsed comment trees with a cache keyed by the info.json mtime. Videos
 * with hundreds of thousands of comments produce info.json files of hundreds
 * of megabytes: the details endpoint and the paginated comments endpoint
 * must not re-parse them on every request, and once a download rewrites the
 * file, the mtime changes and the next read gets the fresh tree.
 *
 * The cache is bounded by memory, not by a count: it used to keep fifty
 * trees whatever their size, and fifty files of a hundred megabytes outgrow
 * a 4 GB heap. Every tree weighs its file size times
 * TREE_HEAP_BYTES_PER_FILE_BYTE, the trees together may hold
 * CACHE_HEAP_SHARE of the heap limit, and the tree read longest ago goes
 * first. Two requests that miss the cache at once share one parse.
 */

/**
 * Heap a parsed tree holds per byte of its info.json: measured from 1.16 for
 * ASCII text to 1.40. Set high, it only caches fewer trees.
 */
export const TREE_HEAP_BYTES_PER_FILE_BYTE = 1.4;
/** Share of the V8 heap limit the cached trees may hold together */
export const CACHE_HEAP_SHARE = 0.25;

interface CacheEntry {
  mtimeMs: number;
  /** Estimated heap the tree holds, in bytes */
  weight: number;
  tree: CommentWithReplies[];
}

/** In the order the trees were last read: the first one is the next to go */
const cache = new Map<string, CacheEntry>();
/** Sum of the weights in the cache */
let cachedWeight = 0;

/** Parses in flight by folder, stem and mtime, so a rewritten file never joins the parse of its older version */
const parses = createSingleFlight<string, CommentWithReplies[]>();

export function invalidateCommentCache(): void {
  cache.clear();
  cachedWeight = 0;
}

/**
 * Store a tree as the most recently read one, then drop the trees read
 * longest ago until the rest fits the budget. The tree just stored always
 * stays, even when it alone passes the budget: the request that parsed it is
 * about to page through it.
 */
function remember(key: string, entry: CacheEntry): void {
  const previous = cache.get(key);
  if (previous !== undefined) {
    cache.delete(key);
    cachedWeight -= previous.weight;
  }
  cache.set(key, entry);
  cachedWeight += entry.weight;

  const budget = v8.getHeapStatistics().heap_size_limit * CACHE_HEAP_SHARE;
  for (const [oldestKey, oldest] of cache) {
    if (cachedWeight <= budget || oldestKey === key) {
      break;
    }
    cache.delete(oldestKey);
    cachedWeight -= oldest.weight;
  }
}

/**
 * The top-level comment tree of a video, or null when its info.json does
 * not exist. Other read errors propagate (the caller maps them to 500).
 */
export async function loadCommentTree(folderPath: string, baseName: string): Promise<CommentWithReplies[] | null> {
  const filePath = path.join(folderPath, `${baseName}.info.json`);
  const key = `${folderPath}\n${baseName}`;

  let mtimeMs: number;
  let size: number;
  try {
    ({ mtimeMs, size } = await fs.stat(filePath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }

  const cached = cache.get(key);
  if (cached !== undefined && cached.mtimeMs === mtimeMs) {
    // Moved to the end: the tree read last is the last to go
    cache.delete(key);
    cache.set(key, cached);
    return cached.tree;
  }

  // A parse that fails is dropped with its promise, so the next request
  // reads the file again rather than getting the old error
  return parses.run(`${key}\n${mtimeMs}`, async () => {
    // Containment check: the info.json must resolve inside the folder even if
    // a symlink tries to redirect the read elsewhere on the disk.
    const realPath = await resolveContainedPath(folderPath, `${baseName}.info.json`);
    const infoJson = JSON.parse(await fs.readFile(realPath, 'utf-8')) as VideoInfoJson;
    const tree = buildCommentTree(infoJson.comments || []);
    remember(key, { mtimeMs, weight: size * TREE_HEAP_BYTES_PER_FILE_BYTE, tree });
    return tree;
  });
}
