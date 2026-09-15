import fs from 'node:fs/promises';
import path from 'node:path';
import type { DownloadOptions, FolderConfig } from '@videodeck/shared/api';
import { isYoutubeChannelUrl } from '@videodeck/shared/youtube';
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
 * pipeline does not use them:
 * - `--exec` / `--exec-before-download` / `--ppa` / `--postprocessor-args` /
 *   `--use-postprocessor` run shell commands or arbitrary binaries (RCE via
 *   config.json);
 * - `--config-locations` loads an arbitrary yt-dlp config;
 * - `--cookies*` exfiltrate the browser cookie jar;
 * - `--proxy` routes the traffic through an arbitrary host;
 * - `--netrc` / `--netrc-cmd` / `--netrc-location` /
 *   `--username` / `--password` leak or read credentials;
 * - `--print-to-file` appends to an arbitrary file (`..` traversal works),
 *   `--batch-file` / `--load-info-json` read arbitrary files whose contents
 *   then land in the job log served to clients;
 * - `--ffmpeg-location` points the merge step at an arbitrary binary;
 * - `--downloader-args` / `--external-downloader-args` forward arbitrary
 *   arguments to external downloaders.
 */
const FORBIDDEN_EXTRA_ARGS = [
  '--exec',
  '--exec-before-download',
  '--config-locations',
  '--cookies',
  '--load-cookies',
  '--cookies-from-browser',
  '--proxy',
  '--netrc',
  '--netrc-cmd',
  '--netrc-location',
  '--username',
  '--password',
  '--video-password',
  '--print-to-file',
  '--batch-file',
  '-a',
  '--load-info-json',
  '--use-postprocessor',
  '--postprocessor-args',
  '--ppa',
  '--downloader-args',
  '--external-downloader-args',
  '--ffmpeg-location',
];

/**
 * Total entries a dropped forbidden flag consumes (the flag itself plus its
 * values). Most flags fall back to orphanValueWidth, but `--print-to-file`
 * takes TWO values (template + file), so it always consumes three entries.
 */
const FORBIDDEN_ARGS_VALUE_WIDTH: Record<string, number> = {
  '--print-to-file': 3,
};

/** Whether an `extraArgs` entry shadows a pipeline-owned flag (`-f`, `-f=…`) */
export function isReservedExtraArg(arg: string): boolean {
  return RESERVED_EXTRA_ARGS.some((reserved) => arg === reserved || arg.startsWith(`${reserved}=`));
}

/** Whether an `extraArgs` entry is a dangerous flag (`--exec`, `--proxy=…`) */
export function isForbiddenExtraArg(arg: string): boolean {
  return FORBIDDEN_EXTRA_ARGS.some((forbidden) => arg === forbidden || arg.startsWith(`${forbidden}=`));
}

/** Error message when `value` is not a valid maxHeight, or null when it is */
function validateMaxHeight(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < MIN_MAX_HEIGHT || value > MAX_MAX_HEIGHT) {
    return `maxHeight must be an integer between ${MIN_MAX_HEIGHT} and ${MAX_MAX_HEIGHT}`;
  }
  return null;
}

/** Error message when `value` is not a valid subLangs list, or null when it is */
function validateSubLangs(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return 'subLangs must be an array of language codes';
  }
  for (const lang of value) {
    if (typeof lang !== 'string' || lang.length === 0 || !SUB_LANG_RE.test(lang)) {
      return `subLangs contains an invalid language code: ${JSON.stringify(lang)}`;
    }
  }
  return null;
}

/** Validator for the plain boolean fields (writeComments, impersonate, …) */
function validateBooleanField(fieldName: string): (value: unknown) => string | null {
  return (value) => (typeof value === 'boolean' ? null : `${fieldName} must be a boolean`);
}

/** Error message when `value` is not a valid fragment concurrency, or null */
function validateConcurrentFragments(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 16) {
    return 'concurrentFragments must be an integer between 1 and 16';
  }
  return null;
}

/** Error message when `value` is not a valid extraArgs list, or null when it is */
function validateExtraArgs(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return 'extraArgs must be an array of yt-dlp arguments';
  }
  for (const arg of value) {
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
  return null;
}

/** Error message when `value` is not a valid category, or null when it is */
function validateCategory(value: unknown): string | null {
  if (typeof value !== 'string') {
    return 'category must be a string';
  }
  const category = value.trim();
  if (category.length === 0) {
    return 'category must not be empty (omit the key instead)';
  }
  if (category.length > MAX_CATEGORY_LENGTH) {
    return `category must be at most ${MAX_CATEGORY_LENGTH} characters`;
  }
  if (/[\r\n]/.test(category)) {
    return 'category must be a single line';
  }
  return null;
}

/** `config.json` fields validated in the order their errors win */
const CONFIG_FIELD_VALIDATORS: Array<[key: string, validate: (value: unknown) => string | null]> = [
  ['maxHeight', validateMaxHeight],
  ['subLangs', validateSubLangs],
  ['writeComments', validateBooleanField('writeComments')],
  ['impersonate', validateBooleanField('impersonate')],
  ['sponsorblockRemove', validateBooleanField('sponsorblockRemove')],
  ['concurrentFragments', validateConcurrentFragments],
  ['extraArgs', validateExtraArgs],
  ['category', validateCategory],
];

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
  // The channel URL reaches yt-dlp unquoted — it must be an https YouTube
  // channel URL, otherwise config.json becomes an SSRF/RCE primitive
  // (file://, internal hosts, `--` argument injection via `yt-dlp <url>`).
  if (typeof c.channelUrl === 'string' && c.channelUrl.trim().length > 0 && !isYoutubeChannelUrl(c.channelUrl)) {
    return 'channelUrl must be a YouTube channel URL (https://youtube.com/@handle, /channel/…, /c/…, /user/…)';
  }

  for (const [key, validate] of CONFIG_FIELD_VALIDATORS) {
    const value = c[key];
    if (value !== undefined) {
      const error = validate(value);
      if (error !== null) {
        return error;
      }
    }
  }

  return null;
}

/** Whether a value is an integer maxHeight within the supported range */
function isValidMaxHeight(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= MIN_MAX_HEIGHT && value <= MAX_MAX_HEIGHT;
}

/** Whether a value is an integer fragment concurrency within 1–16 */
function isValidConcurrency(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 16;
}

/** Whether a value is a non-empty yt-dlp language selector */
function isLanguageCode(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && SUB_LANG_RE.test(value);
}

/**
 * Extra entries a dropped flag consumes on top of itself: 1 when its value is
 * glued (`--proxy=http://p`) or the flag takes none, 2 when the value is the
 * next entry (only for flags that take one — `valueFlags`).
 */
function orphanValueWidth(arg: string, next: unknown, valueFlags: readonly string[] | undefined): number {
  if (arg.includes('=')) {
    return 1;
  }
  if (valueFlags !== undefined && !valueFlags.includes(arg)) {
    return 1;
  }
  return typeof next === 'string' && !next.startsWith('-') ? 2 : 1;
}

/**
 * Accept every extraArg that the pipeline does not own and that is not
 * forbidden. A dropped flag like `-f` orphans its value ("best") — that is
 * dropped too, unless the value is glued (`-f=best`) or the flag takes none.
 */
function resolveExtraArgs(extraArgs: unknown[]): string[] {
  const accepted: string[] = [];
  let index = 0;
  while (index < extraArgs.length) {
    const arg = extraArgs[index];
    if (typeof arg !== 'string' || arg.trim().length === 0) {
      index += 1;
      continue;
    }
    if (isReservedExtraArg(arg)) {
      index += orphanValueWidth(arg, extraArgs[index + 1], RESERVED_ARGS_WITH_VALUE);
      continue;
    }
    if (isForbiddenExtraArg(arg)) {
      // Drop the flag and its value(s): `--proxy http://p` arrives as two
      // entries, `--print-to-file` as three (template + file).
      const extraWidth = FORBIDDEN_ARGS_VALUE_WIDTH[arg];
      index += extraWidth ?? orphanValueWidth(arg, extraArgs[index + 1], undefined);
      continue;
    }
    accepted.push(arg);
    index += 1;
  }
  return accepted;
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

  if (isValidMaxHeight(config.maxHeight)) {
    options.maxHeight = config.maxHeight;
  }

  if (Array.isArray(config.subLangs)) {
    options.subLangs = config.subLangs.filter(isLanguageCode);
  }

  if (typeof config.writeComments === 'boolean') {
    options.writeComments = config.writeComments;
  }

  options.impersonate = config.impersonate === true;
  options.sponsorblockRemove = config.sponsorblockRemove === true;

  if (isValidConcurrency(config.concurrentFragments)) {
    options.concurrentFragments = config.concurrentFragments;
  }

  if (Array.isArray(config.extraArgs)) {
    options.extraArgs = resolveExtraArgs(config.extraArgs);
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
  if (categoryCache !== null && categoryCache.key === key && now - categoryCache.readAt < CATEGORY_CACHE_TTL_MS) {
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
