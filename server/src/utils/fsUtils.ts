import fs from 'fs/promises';
import path from 'path';
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
 * Remove the temporary files yt-dlp leaves in a folder when a download is
 * cancelled (`.mp4.part`, fragment files, `.ytdl`). Safe to run any time: at
 * most one `download` job runs per folder, and updates never write partials.
 * Errors are logged, never thrown — cleanup must not break the queue.
 */
export async function removePartialDownloads(folderPath: string): Promise<void> {
  let names: string[];
  try {
    names = (await fs.readdir(folderPath)) ?? [];
  } catch {
    return;
  }
  await Promise.all(
    names
      .filter((name) => PARTIAL_FILE_PATTERNS.some((pattern) => pattern.test(name)))
      .map((name) =>
        fs.unlink(path.join(folderPath, name)).catch((error: unknown) => {
          logger.warn(
            `Cannot remove partial download ${name}: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        })
      )
  );
}
