import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Turning `VIDEOS_FOLDER_PATH` into the folders that exist right now.
 *
 * One half of the library: the roots, the segment-level glob expansion and the
 * two scans (a synchronous one for the cold boot, an asynchronous one for every
 * pass after it). Nothing here holds state or publishes anything, so it can be
 * read and tested on its own; `libraryState.ts` owns the snapshot these scans
 * feed.
 */

// ---------------------------------------------------------------------------
// Parsing and glob expansion
// ---------------------------------------------------------------------------

/** `~/…` → the absolute home path (so ~-paths work in .env like in a shell) */
function expandTilde(entry: string): string {
  if (entry === '~') {
    return os.homedir();
  }
  if (entry.startsWith('~/')) {
    return path.join(os.homedir(), entry.slice(2));
  }
  return entry;
}

/**
 * Roots of one raw `VIDEOS_FOLDER_PATH`: split on `;` or `,`, trimmed, `~/`
 * expanded, duplicates dropped, in the order they were written.
 */
export function parseLibraryRoots(raw: string): string[] {
  const roots: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw.split(/[;,]/)) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const expanded = expandTilde(trimmed);
    if (!seen.has(expanded)) {
      seen.add(expanded);
      roots.push(expanded);
    }
  }
  return roots;
}

export function hasGlobMagic(value: string): boolean {
  return value.includes('*');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

/** `drone-*` → `^drone-[^/]*$` (`*` matches within one path segment only) */
function globSegmentToRegExp(segment: string): RegExp {
  const source = segment.split('*').map(escapeRegExp).join('[^/]*');
  return new RegExp(`^${source}$`);
}

/**
 * Whether one configured root could still produce this folder, which is what
 * keeps a remembered folder worth remembering. A literal root covers itself; a
 * glob root covers the paths its segments match, whether or not the drive is
 * mounted right now.
 */
export function coversRoot(folderPath: string, root: string): boolean {
  if (!hasGlobMagic(root)) {
    return folderPath === root;
  }
  const rootSegments = root.split('/').filter((segment) => segment.length > 0);
  const folderSegments = folderPath.split('/').filter((segment) => segment.length > 0);
  if (rootSegments.length !== folderSegments.length) {
    return false;
  }
  return rootSegments.every((segment, index) => {
    const folderSegment = folderSegments[index] ?? '';
    return segment.includes('*') ? globSegmentToRegExp(segment).test(folderSegment) : segment === folderSegment;
  });
}

/** Direct subdirectory names; [] when unreadable */
function listDirectories(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

export function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** Directories matched by one pattern segment below the given bases */
function expandSegment(segment: string, bases: readonly string[]): string[] {
  const next: string[] = [];
  if (segment.includes('*')) {
    const matcher = globSegmentToRegExp(segment);
    for (const base of bases) {
      for (const name of listDirectories(base)) {
        if (matcher.test(name)) {
          next.push(path.join(base, name));
        }
      }
    }
    return next;
  }
  for (const base of bases) {
    const candidate = path.join(base, segment);
    if (isDirectory(candidate)) {
      next.push(candidate);
    }
  }
  return next;
}

/**
 * Expand a path pattern whose segments may contain `*` (one level each, no
 * `**`). Only existing directories are returned, walking the literal segments
 * first so a pattern rooted at a volume path never descends into a volume
 * that is not mounted.
 */
function expandGlob(pattern: string): string[] {
  const segments = pattern.split('/').filter((segment) => segment.length > 0);
  let current = [pattern.startsWith('/') ? '/' : '.'];
  for (const segment of segments) {
    current = expandSegment(segment, current);
    if (current.length === 0) {
      return [];
    }
  }
  return current;
}

/**
 * Whether a directory looks like a channel folder: it holds a `config.json`
 * or at least one `*.info.json` directly (yt-dlp writes both into the folder
 * it downloads into). This is what lets a wildcard over a volume's entries
 * match channel folders but skip unrelated directories of other volumes.
 */
function isChannelFolder(folderPath: string): boolean {
  try {
    return fs
      .readdirSync(folderPath, { withFileTypes: true })
      .some((entry) => entry.isFile() && (entry.name === 'config.json' || entry.name.endsWith('.info.json')));
  } catch {
    return false;
  }
}

/** Direct subdirectory names via async fs; [] when unreadable */
async function listDirectoriesAsync(dir: string): Promise<string[]> {
  try {
    const entries = await fsPromises.readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function isDirectoryAsync(dir: string): Promise<boolean> {
  try {
    return (await fsPromises.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

async function isChannelFolderAsync(folderPath: string): Promise<boolean> {
  try {
    const entries = await fsPromises.readdir(folderPath, { withFileTypes: true });
    return entries.some(
      (entry) => entry.isFile() && (entry.name === 'config.json' || entry.name.endsWith('.info.json')),
    );
  } catch {
    return false;
  }
}

/** Directories matched by one pattern segment below the given bases (async) */ async function expandSegmentAsync(
  segment: string,
  bases: readonly string[],
): Promise<string[]> {
  const next: string[] = [];
  if (segment.includes('*')) {
    const matcher = globSegmentToRegExp(segment);
    for (const base of bases) {
      for (const name of await listDirectoriesAsync(base)) {
        if (matcher.test(name)) {
          next.push(path.join(base, name));
        }
      }
    }
    return next;
  }
  for (const base of bases) {
    const candidate = path.join(base, segment);
    if (await isDirectoryAsync(candidate)) {
      next.push(candidate);
    }
  }
  return next;
}

async function expandGlobAsync(pattern: string): Promise<string[]> {
  const segments = pattern.split('/').filter((segment) => segment.length > 0);
  let current = [pattern.startsWith('/') ? '/' : '.'];
  for (const segment of segments) {
    current = await expandSegmentAsync(segment, current);
    if (current.length === 0) {
      return [];
    }
  }
  return current;
}

// ---------------------------------------------------------------------------
// Scanning and publishing
// ---------------------------------------------------------------------------

export interface LibraryScan {
  readonly raw: string;
  readonly roots: readonly string[];
  readonly folders: readonly string[];
  /** Literal roots that are not a directory right now (a drive that is away) */
  readonly awayLiterals: readonly string[];
}

/** Push a folder once, keeping the order the roots were written in */
function pushFolder(folders: string[], seen: Set<string>, folderPath: string): void {
  if (!seen.has(folderPath)) {
    seen.add(folderPath);
    folders.push(folderPath);
  }
}

/**
 * The scan of the cold-boot read. A literal root is kept whatever the disk
 * says, exactly as the folder cache this module replaced did: callers such as
 * the queue have to keep resolving a folder on a drive that is away, and
 * `unavailable` is what marks it.
 */
export function scanLibrarySync(raw: string): LibraryScan {
  const roots = parseLibraryRoots(raw);
  const folders: string[] = [];
  const awayLiterals: string[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    if (hasGlobMagic(root)) {
      for (const folderPath of expandGlob(root).filter(isChannelFolder).sort()) {
        pushFolder(folders, seen, folderPath);
      }
      continue;
    }
    if (!isDirectory(root)) {
      awayLiterals.push(root);
    }
    pushFolder(folders, seen, root);
  }
  return { raw, roots, folders, awayLiterals };
}

/** The same scan off the event loop, for anything that is not the cold boot */
export async function scanLibraryAsync(raw: string): Promise<LibraryScan> {
  const roots = parseLibraryRoots(raw);
  const folders: string[] = [];
  const awayLiterals: string[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    if (hasGlobMagic(root)) {
      const candidates = await expandGlobAsync(root);
      const matched: string[] = [];
      for (const folderPath of candidates) {
        if (await isChannelFolderAsync(folderPath)) {
          matched.push(folderPath);
        }
      }
      for (const folderPath of matched.sort()) {
        pushFolder(folders, seen, folderPath);
      }
      continue;
    }
    if (!(await isDirectoryAsync(root))) {
      awayLiterals.push(root);
    }
    pushFolder(folders, seen, root);
  }
  return { raw, roots, folders, awayLiterals };
}
