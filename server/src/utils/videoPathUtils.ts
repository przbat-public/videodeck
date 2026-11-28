import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getVideosFolderPaths } from '../config';
import { logger } from './logger';

/**
 * Normalize a folder path before comparing it against the configured list:
 * expand a leading `~/` (the extension options are hand-typed, so `~` and a
 * trailing slash are the most common mismatches) and strip trailing slashes.
 */
export function normalizeFolderPath(value: string): string {
  let normalized = value;
  if (normalized === '~') {
    normalized = os.homedir();
  } else if (normalized.startsWith('~/')) {
    normalized = path.join(os.homedir(), normalized.slice(2));
  }
  while (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

/**
 * The configured folder a path names, as the configured entry itself, or
 * undefined when the list holds no such folder. It resolves nothing, so the
 * root, a parent or a `..` spelling never matches.
 *
 * It hands back the configured entry, never the argument: the two strings are
 * equal, but only the configured one is provably free of request or index
 * data, which is what lets CodeQL js/path-injection treat this check as the
 * sanitizer it is. Callers build every later path from the return value. The
 * folder routes (routes/folder/guards.ts), the file route
 * (routes/videos/files.ts) and the single-video lookup
 * (services/elasticsearch/search.ts) all decide through it.
 */
export function findConfiguredFolder(folderPath: string): string | undefined {
  const normalized = normalizeFolderPath(folderPath);
  const configured = getVideosFolderPaths().find((candidate) => normalizeFolderPath(candidate) === normalized);
  return configured === undefined ? undefined : normalizeFolderPath(configured);
}

/** Whether anything exists at this path, a directory or not */
async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Where a missing folder that is a link leads, or null when it is no link.
 * readlink only answers for a link, and the folder is missing, so a link here
 * is one left pointing nowhere. A trailing slash would make readlink follow
 * the link, so it goes first.
 */
async function danglingLinkTarget(folderPath: string): Promise<string | null> {
  const link = folderPath.replace(/\/+$/, '') || folderPath;
  try {
    return path.resolve(path.dirname(link), await fs.readlink(link));
  } catch {
    return null;
  }
}

/** Whether this is a directory with nothing in it */
async function isEmptyDirectory(target: string): Promise<boolean> {
  try {
    return (await fs.readdir(target)).length === 0;
  } catch {
    return false;
  }
}

/** What a missing folder looks like: the line that says so, and where a glob that waits for it would start */
interface MissingFolder {
  line: string;
  globParent: string;
  linked: boolean;
}

/**
 * The line for a folder that does not exist. The parent tells the usual
 * causes apart: an empty parent is how a Linux mount point (an fstab entry, a
 * Docker bind target) looks without its drive, though it may be a typo on a
 * drive that holds nothing else; a parent with entries points at a typo in
 * the last segment; and a parent that is missing as well at a drive that is
 * not mounted. A link left pointing nowhere is read the same way, by the
 * parent of its target, and the glob for it starts there: a glob segment
 * matches real directories only, never a link.
 */
async function describeMissingFolder(folderPath: string): Promise<MissingFolder> {
  const linkTarget = await danglingLinkTarget(folderPath);
  if (linkTarget !== null) {
    const targetParent = path.dirname(linkTarget);
    const driveHere = (await pathExists(targetParent)) && !(await isEmptyDirectory(targetParent));
    const cause = driveHere ? "check the link's target" : 'the drive looks unmounted';
    return {
      line: `${folderPath} links to ${linkTarget}, which does not exist: ${cause}`,
      globParent: targetParent,
      linked: true,
    };
  }
  const parent = path.dirname(folderPath);
  if (await isEmptyDirectory(parent)) {
    return {
      line: `${folderPath} does not exist, and ${parent} is empty: the drive looks unmounted, or check the spelling`,
      globParent: parent,
      linked: false,
    };
  }
  if (await pathExists(parent)) {
    return {
      line: `${folderPath} does not exist, but ${parent} does: check the spelling`,
      globParent: parent,
      linked: false,
    };
  }
  return {
    line: `${folderPath} does not exist, and neither does ${parent}: the drive looks unmounted`,
    globParent: parent,
    linked: false,
  };
}

/**
 * The lines for the folders that do not exist, none when every folder does,
 * closed by one line on how to start without the drive. Only a folder written
 * out in full can be missing here, because a glob expands to the folders that
 * exist. A glob that matches nothing warns only when no other entry matches
 * either (libraryState.ts), so the line promises no more. The glob in it is
 * built from the first missing folder and offered as an example, not as a
 * fix: it matches the sibling channel folders as well.
 */
async function describeMissingFolders(missing: readonly string[]): Promise<string[]> {
  const [first] = missing;
  if (first === undefined) {
    return [];
  }
  const described = await Promise.all(missing.map((folderPath) => describeMissingFolder(folderPath)));
  const lines = described.map((folder) => folder.line);
  const pattern = path.join(described[0]?.globParent ?? path.dirname(first), '*');
  lines.push(
    'A folder written out in full must exist at startup. A glob that matches nothing lets the server start, ' +
      'with a warning only when nothing else matches, and picks up its folders once the drive is mounted: ' +
      `for example ${pattern}, which also matches the folders beside the missing one` +
      (described[0]?.linked ? '; a linked folder then shows up under the path its link leads to.' : '.'),
  );
  return lines;
}

/**
 * Validate that every configured folder exists. A missing one fails the boot on
 * purpose, since it is often a typo that would otherwise pass for an empty
 * library (docs/plans/library-state.md); the message says which of the two
 * usual causes it looks like and how to start without the drive.
 */
export async function validateVideosFolder(): Promise<void> {
  const folderPaths = getVideosFolderPaths();

  // Glob entries that matched nothing yield an empty list (a drive that is
  // not mounted), and that is a valid state to boot in: the folders appear
  // once the drive comes back, because the list follows watch events on the
  // directories that decide it, plus a check every minute (libraryWatch.ts).
  if (folderPaths.length === 0) {
    logger.warn(
      'No video folders found — search, downloads and reindexing stay unavailable until a configured drive is mounted.',
    );
    return;
  }

  const errors: string[] = [];
  const missing: string[] = [];

  for (const folderPath of folderPaths) {
    try {
      const stats = await fs.stat(folderPath);
      if (!stats.isDirectory()) {
        errors.push(`${folderPath} is not a directory`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        missing.push(folderPath);
      } else {
        errors.push(`Error accessing ${folderPath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  errors.push(...(await describeMissingFolders(missing)));
  if (errors.length > 0) {
    throw new Error(`VIDEOS_FOLDER_PATH validation failed:\n${errors.join('\n')}`);
  }
}

// Sanitize filename to prevent path traversal
export function sanitizeFilename(filename: string): string {
  // Express already URL-decodes route parameters. basename() strips any
  // leftover separators, so only an encoded separator could survive — and
  // basename removes those too.
  const sanitized = path.basename(filename);

  // Only explicit directory references are rejected: "." and ".." as the
  // whole name. Names with dots inside ("file..webp") are regular files.
  if (sanitized === '.' || sanitized === '..') {
    throw new Error('Invalid filename: path traversal detected');
  }

  if (!sanitized || sanitized.trim().length === 0) {
    throw new Error('Invalid filename: empty filename');
  }

  return sanitized;
}

// Get full path to a file in videos folder
export function getVideoFilePath(filename: string, folderPath?: string): string {
  const sanitized = sanitizeFilename(filename);

  if (folderPath) {
    // Use provided folder path (from video item)
    return path.join(folderPath, sanitized);
  }

  // Fallback: the first configured folder (kept for files that are not indexed)
  const [firstFolder] = getVideosFolderPaths();
  if (firstFolder === undefined) {
    throw new Error('No video folders configured');
  }
  return path.join(firstFolder, sanitized);
}
