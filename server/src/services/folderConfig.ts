import fs from 'fs/promises';
import path from 'path';
import type { DownloadOptions, FolderConfig } from '@shared/api';
import { getVideosFolderPaths } from '../config';
import { logger } from '../utils/logger';

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
  extraArgs: [],
  impersonate: false,
  concurrentFragments: 1,
  sponsorblockRemove: false,
};

export const MIN_MAX_HEIGHT = 144;
export const MAX_MAX_HEIGHT = 4320;

export const MAX_CATEGORY_LENGTH = 64;

/** yt-dlp language selectors: `en`, `pl`, `en-US`, `en.*`, `all`, `-live_chat` */
const SUB_LANG_RE = /^-?[A-Za-z0-9._*-]+$/;

/**
 * Flags the download pipeline owns: the archive (`--download-archive`) is
 * what deduplicates re-uploads under a changed title, the output template
 * (`-o`) is what the folder index parses, `-f`/`--merge-output-format`
 * produce the playable mp4, and `--paths` would break the folder layout.
 * A per-folder config may not override any of them.
 */
const RESERVED_EXTRA_ARGS = [
  '-f',
  '--format',
  '-o',
  '--output',
  '-P',
  '--paths',
  '--download-archive',
  '--no-download-archive',
  '--merge-output-format',
];

/** Reserved flags that take their value as the next entry (`--proxy http://p`) */
const RESERVED_ARGS_WITH_VALUE = [
  '-f',
  '--format',
  '-o',
  '--output',
  '-P',
  '--paths',
  '--download-archive',
  '--merge-output-format',
];

/**
 * Flags a per-folder config may never pass to yt-dlp, even though the
 * pipeline does not use them: `--exec` runs a shell command (RCE via
 * config.json), `--config-locations` loads an arbitrary yt-dlp config,
 * `--cookies*` exfiltrate the browser cookie jar, `--proxy` routes the
 * traffic through an arbitrary host, and `--netrc`/`--username`/`--password`
 * leak credentials into the process list and logs.
 */
const FORBIDDEN_EXTRA_ARGS = [
  '--exec',
  '--config-locations',
  '--cookies',
  '--load-cookies',
  '--cookies-from-browser',
  '--proxy',
  '--netrc',
  '--username',
  '--password',
  '--video-password',
];

/** Whether an `extraArgs` entry shadows a pipeline-owned flag (`-f`, `-f=…`) */
export function isReservedExtraArg(arg: string): boolean {
  return RESERVED_EXTRA_ARGS.some((reserved) => arg === reserved || arg.startsWith(`${reserved}=`));
}

/** Whether an `extraArgs` entry is a dangerous flag (`--exec`, `--proxy=…`) */
export function isForbiddenExtraArg(arg: string): boolean {
  return FORBIDDEN_EXTRA_ARGS.some(
    (forbidden) => arg === forbidden || arg.startsWith(`${forbidden}=`)
  );
}

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

  if (c.impersonate !== undefined && typeof c.impersonate !== 'boolean') {
    return 'impersonate must be a boolean';
  }

  if (c.sponsorblockRemove !== undefined && typeof c.sponsorblockRemove !== 'boolean') {
    return 'sponsorblockRemove must be a boolean';
  }

  if (c.concurrentFragments !== undefined) {
    if (
      typeof c.concurrentFragments !== 'number' ||
      !Number.isInteger(c.concurrentFragments) ||
      c.concurrentFragments < 1 ||
      c.concurrentFragments > 16
    ) {
      return 'concurrentFragments must be an integer between 1 and 16';
    }
  }

  if (c.extraArgs !== undefined) {
    if (!Array.isArray(c.extraArgs)) {
      return 'extraArgs must be an array of yt-dlp arguments';
    }
    for (const arg of c.extraArgs) {
      if (typeof arg !== 'string' || arg.trim().length === 0) {
        return `extraArgs contains an invalid argument: ${JSON.stringify(arg)}`;
      }
      if (isReservedExtraArg(arg)) {
        return `extraArgs must not override the built-in argument: ${arg}`;
      }
      if (isForbiddenExtraArg(arg)) {
        return `extraArgs must not use the restricted argument: ${arg}`;
      }
    }
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
    extraArgs: [...(DEFAULT_DOWNLOAD_OPTIONS.extraArgs ?? [])],
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

  options.impersonate = config.impersonate === true;
  options.sponsorblockRemove = config.sponsorblockRemove === true;

  if (
    typeof config.concurrentFragments === 'number' &&
    Number.isInteger(config.concurrentFragments) &&
    config.concurrentFragments >= 1 &&
    config.concurrentFragments <= 16
  ) {
    options.concurrentFragments = config.concurrentFragments;
  }

  if (Array.isArray(config.extraArgs)) {
    options.extraArgs = [];
    for (let index = 0; index < config.extraArgs.length; index += 1) {
      const arg = config.extraArgs[index];
      if (typeof arg !== 'string' || arg.trim().length === 0) {
        continue;
      }
      if (isReservedExtraArg(arg)) {
        // A dropped flag like `-f` orphans its value ("best") — drop that too,
        // unless the value is glued (`-f=best`) or the flag takes none.
        const next = config.extraArgs[index + 1];
        if (
          !arg.includes('=') &&
          RESERVED_ARGS_WITH_VALUE.includes(arg) &&
          typeof next === 'string' &&
          !next.startsWith('-')
        ) {
          index += 1;
        }
        continue;
      }
      if (isForbiddenExtraArg(arg)) {
        // Same orphan-value handling: `--proxy http://p` arrives as two entries.
        const next = config.extraArgs[index + 1];
        if (!arg.includes('=') && typeof next === 'string' && !next.startsWith('-')) {
          index += 1;
        }
        continue;
      }
      options.extraArgs.push(arg);
    }
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
      logger.error(`Error reading config for ${folderPath}:`, error);
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
