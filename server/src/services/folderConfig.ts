import fs from 'fs/promises';
import path from 'path';
import type { DownloadOptions, FolderConfig } from '@shared/api';
import { getVideosFolderPaths } from '../config';

/**
 * Per-folder `config.json` (shape: `FolderConfig` in shared/api.ts).
 *
 * Besides the channel URL it carries the yt-dlp download options for that
 * channel, so Polish channels can ask for `pl` subtitles, big 4K channels can
 * be capped at 1080p, etc. Missing keys fall back to DEFAULT_DOWNLOAD_OPTIONS.
 */

export const DEFAULT_DOWNLOAD_OPTIONS: DownloadOptions = {
  maxHeight: 2160,
  subLangs: ['en'],
  writeComments: true,
};

export const MIN_MAX_HEIGHT = 144;
export const MAX_MAX_HEIGHT = 4320;

export const MAX_CATEGORY_LENGTH = 64;

/** yt-dlp language selectors: `en`, `pl`, `en-US`, `en.*`, `all`, `-live_chat` */
const SUB_LANG_RE = /^-?[A-Za-z0-9._*-]+$/;

/**
 * Validate a config object coming from the client.
 * Returns an error message, or null when the config is acceptable.
 */
export function validateFolderConfig(config: unknown): string | null {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return 'config object is required';
  }
  const c = config as Record<string, unknown>;

  if (c.channelUrl !== undefined && typeof c.channelUrl !== 'string') {
    return 'channelUrl must be a string';
  }

  if (c.maxHeight !== undefined) {
    if (
      typeof c.maxHeight !== 'number' ||
      !Number.isInteger(c.maxHeight) ||
      c.maxHeight < MIN_MAX_HEIGHT ||
      c.maxHeight > MAX_MAX_HEIGHT
    ) {
      return `maxHeight must be an integer between ${MIN_MAX_HEIGHT} and ${MAX_MAX_HEIGHT}`;
    }
  }

  if (c.subLangs !== undefined) {
    if (!Array.isArray(c.subLangs)) {
      return 'subLangs must be an array of language codes';
    }
    for (const lang of c.subLangs) {
      if (typeof lang !== 'string' || lang.length === 0 || !SUB_LANG_RE.test(lang)) {
        return `subLangs contains an invalid language code: ${JSON.stringify(lang)}`;
      }
    }
  }

  if (c.writeComments !== undefined && typeof c.writeComments !== 'boolean') {
    return 'writeComments must be a boolean';
  }

  if (c.category !== undefined) {
    if (typeof c.category !== 'string') {
      return 'category must be a string';
    }
    const category = c.category.trim();
    if (category.length === 0) {
      return 'category must not be empty (omit the key instead)';
    }
    if (category.length > MAX_CATEGORY_LENGTH) {
      return `category must be at most ${MAX_CATEGORY_LENGTH} characters`;
    }
    if (/[\r\n]/.test(category)) {
      return 'category must be a single line';
    }
  }

  return null;
}

/**
 * Effective download options for a folder: config values over defaults.
 * Invalid values are ignored (defaults win) so a hand-edited config.json
 * cannot break downloads.
 */
export function resolveDownloadOptions(config: FolderConfig | null | undefined): DownloadOptions {
  const options: DownloadOptions = {
    ...DEFAULT_DOWNLOAD_OPTIONS,
    subLangs: [...DEFAULT_DOWNLOAD_OPTIONS.subLangs],
  };
  if (!config) {
    return options;
  }

  if (
    typeof config.maxHeight === 'number' &&
    Number.isInteger(config.maxHeight) &&
    config.maxHeight >= MIN_MAX_HEIGHT &&
    config.maxHeight <= MAX_MAX_HEIGHT
  ) {
    options.maxHeight = config.maxHeight;
  }

  if (Array.isArray(config.subLangs)) {
    options.subLangs = config.subLangs.filter(
      (lang): lang is string =>
        typeof lang === 'string' && lang.length > 0 && SUB_LANG_RE.test(lang)
    );
  }

  if (typeof config.writeComments === 'boolean') {
    options.writeComments = config.writeComments;
  }

  return options;
}

/**
 * Read `config.json` of a folder; null when it does not exist or is unreadable.
 */
export async function readFolderConfig(folderPath: string): Promise<FolderConfig | null> {
  try {
    const content = await fs.readFile(path.join(folderPath, 'config.json'), 'utf-8');
    const parsed: unknown = JSON.parse(content);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as FolderConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`Error reading config for ${folderPath}:`, error);
    }
    return null;
  }
}

/**
 * Download options for a folder, read straight from its config.json.
 */
export async function loadDownloadOptions(folderPath: string): Promise<DownloadOptions> {
  return resolveDownloadOptions(await readFolderConfig(folderPath));
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

/**
 * The folder's category exactly as config.json declares it (trimmed), or
 * undefined when it declares none. Never guessed from the folder name — a
 * folder called `drone-joyplanes` may well be an aviation channel.
 */
export function resolveCategory(config: FolderConfig | null | undefined): string | undefined {
  const category = typeof config?.category === 'string' ? config.category.trim() : '';
  return category.length > 0 ? category : undefined;
}

/**
 * Categories are resolved on every filtered search, and the folders live on
 * an external disk where reading 56 config files one after another measured
 * 0.7–3 s. So the files are read in parallel and the result is kept for a few
 * seconds: long enough to absorb a burst of search-as-you-type requests,
 * short enough that a hand-edited config.json shows up without a restart.
 * Saving through the API invalidates the cache immediately.
 */
export const CATEGORY_CACHE_TTL_MS = 5_000;

interface CategoryCache {
  /** Configured folders the entry was built for (they can differ in tests) */
  key: string;
  readAt: number;
  categories: Map<string, string>;
}

let categoryCache: CategoryCache | null = null;

/** Drop the cached categories — call after writing a config.json */
export function invalidateCategoryCache(): void {
  categoryCache = null;
}

/** folderPath → category, for every configured folder that declares one */
async function readCategories(): Promise<Map<string, string>> {
  const folderPaths = getVideosFolderPaths();
  const key = folderPaths.join('\n');
  const now = Date.now();
  if (
    categoryCache !== null &&
    categoryCache.key === key &&
    now - categoryCache.readAt < CATEGORY_CACHE_TTL_MS
  ) {
    return categoryCache.categories;
  }

  const configs = await Promise.all(folderPaths.map((folderPath) => readFolderConfig(folderPath)));
  const categories = new Map<string, string>();
  folderPaths.forEach((folderPath, index) => {
    const category = resolveCategory(configs[index]);
    if (category) {
      categories.set(folderPath, category);
    }
  });

  categoryCache = { key, readAt: now, categories };
  return categories;
}

/**
 * Distinct categories across all configured folders, sorted. Spellings that
 * differ only in case collapse into the first one found.
 */
export async function listCategories(): Promise<string[]> {
  const byLowercase = new Map<string, string>();
  for (const category of (await readCategories()).values()) {
    const key = category.toLowerCase();
    if (!byLowercase.has(key)) {
      byLowercase.set(key, category);
    }
  }
  return [...byLowercase.values()].sort((a, b) => a.localeCompare(b));
}

/**
 * Folders that config.json puts in `category` (compared case-insensitively).
 * An empty result means nothing matched; callers must then return no videos
 * rather than falling back to searching every folder.
 */
export async function getFolderPathsForCategory(category: string): Promise<string[]> {
  const wanted = category.trim().toLowerCase();
  if (wanted.length === 0) {
    return [];
  }
  const folderPaths: string[] = [];
  for (const [folderPath, folderCategory] of await readCategories()) {
    if (folderCategory.toLowerCase() === wanted) {
      folderPaths.push(folderPath);
    }
  }
  return folderPaths;
}
