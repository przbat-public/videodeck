import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { logger } from './logger';

/**
 * File names in a folder without the dotfiles (the app's own helper files:
 * `.videos-index.json` and friends must never be mistaken for videos).
 */
export async function listVisibleFiles(folderPath: string): Promise<string[]> {
  const files = await fs.readdir(folderPath);
  return files.filter((file) => !file.startsWith('.'));
}

/** yt-dlp temporary files left behind when a download is killed */
const PARTIAL_FILE_PATTERNS = [/\.part$/, /\.part-/, /\.ytdl$/, /\.temp$/];

/**
 * Whether `name` is a temporary file yt-dlp may leave for a file it announced
 * as `destination`. The check is anchored on the announced name: yt-dlp writes
 * the partial next to the file (`Video.mp4.part`, `Video.f137.mp4.part`,
 * `Video.mp4.part-Frag1`) and names the resume/temp sidecars after the output
 * template stem (`Video.ytdl`, `Video.temp`).
 */
function isPartialOf(name: string, destination: string): boolean {
  if (!PARTIAL_FILE_PATTERNS.some((pattern) => pattern.test(name))) {
    return false;
  }
  if (name.startsWith(`${destination}.`)) {
    return true;
  }
  const stem = destination.replace(/\.[^.]+$/, '');
  return stem !== destination && name.startsWith(`${stem}.`);
}

/** `folderPath` resolved and normalized, with a trailing separator */
function folderRootOf(folderPath: string): string {
  const resolved = path.resolve(folderPath);
  return resolved.endsWith(path.sep) ? resolved : `${resolved}${path.sep}`;
}

/** Absolute path of `fileName` inside `folderPath`, or throws when it escapes */
function containedFilePath(folderPath: string, fileName: string, verb: string): string {
  const filePath = path.resolve(path.join(folderPath, fileName));
  if (!filePath.startsWith(folderRootOf(folderPath))) {
    throw new Error(`Refusing to ${verb} ${fileName}: resolved outside ${folderPath}`);
  }
  return filePath;
}

/**
 * Resolve the real path of a file inside a folder, refusing symlinks that
 * escape it. Returns the resolved path so callers can read it without a
 * TOCTOU window. Throws ENOENT when the file does not exist and a plain
 * Error when the resolved target lies outside the folder (a symlink planted
 * by another local user or by a hand-edited config must not make the server
 * read or serve files elsewhere on the disk).
 */
export async function resolveContainedPath(folderPath: string, fileName: string): Promise<string> {
  const filePath = containedFilePath(folderPath, fileName, 'read');
  const folderRoot = folderRootOf(folderPath);
  const [realFile, realFolder] = await Promise.all([fs.realpath(filePath), fs.realpath(folderRoot)]);
  const realRoot = realFolder.endsWith(path.sep) ? realFolder : `${realFolder}${path.sep}`;
  if (!realFile.startsWith(realRoot)) {
    throw new Error(`Refusing to read ${fileName}: resolved outside ${folderPath}`);
  }
  return realFile;
}

/**
 * Atomic plain-text write: unique temp file + fsync + rename, so a crash or
 * a full disk never leaves a truncated file at the final path. The temp name
 * is unique per write — concurrent writers (the queue persists its state on
 * several rapid events) must never truncate each other's temp file, which
 * used to interleave their payloads.
 */
async function writeTextAtomicPrivate(filePath: string, text: string): Promise<void> {
  const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await fs.open(tmp, 'w');
  try {
    await handle.writeFile(text, 'utf-8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(tmp, filePath);
  } catch (error) {
    await fs.unlink(tmp).catch(() => {
      /* best-effort cleanup of the temp file */
    });
    throw error;
  }
}

/**
 * Atomic JSON write of `fileName` inside `folderPath`: temp file + fsync +
 * rename, so a crash or a full disk never leaves a truncated file at the
 * final path (readers would otherwise serve or fall back on half-written
 * JSON forever). The file name must stay inside the folder (no traversal).
 */
export async function writeJsonAtomic(folderPath: string, fileName: string, data: unknown): Promise<void> {
  const filePath = containedFilePath(folderPath, fileName, 'write');
  await writeTextAtomicPrivate(filePath, JSON.stringify(data, null, 2));
}

/**
 * Atomic plain-text write: temp file + fsync + rename (the JSON sibling
 * writeJsonAtomic stringifies; this one writes raw text).
 */
export async function writeTextAtomic(filePath: string, text: string): Promise<void> {
  await writeTextAtomicPrivate(filePath, text);
}

/**
 * Remove the temporary files yt-dlp left behind for the files it announced as
 * `destinations` before the download was cancelled (`.mp4.part`, fragment
 * files, `.ytdl`). Only files that continue one of those names are touched:
 * the folder may already hold the half-written file of the download that
 * starts next, and sweeping the whole folder used to delete exactly that.
 * Errors are logged, never thrown — cleanup must not break the queue.
 */
export async function removePartialDownloads(folderPath: string, destinations: readonly string[]): Promise<void> {
  if (destinations.length === 0) {
    return;
  }
  let names: string[];
  try {
    names = (await fs.readdir(folderPath)) ?? [];
  } catch {
    return;
  }
  await Promise.all(
    names
      .filter((name) => destinations.some((destination) => isPartialOf(name, destination)))
      .map((name) =>
        fs.unlink(path.join(folderPath, name)).catch((error: unknown) => {
          logger.warn(
            `Cannot remove partial download ${name}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }),
      ),
  );
}
