import fs from 'node:fs/promises';
import path from 'node:path';
import type { DownloadOptions, FolderConfig } from '@videodeck/shared/api';
import { FolderKindSchema } from '@videodeck/shared/schemas';
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

/** Value shapes for the allowlisted flags that take one */
const SECONDS_RE = /^(?:0|[1-9]\d{0,4})(?:\.\d{1,3})?$/;
const RATE_RE = /^(?:0|[1-9]\d{0,9})(?:\.\d{1,3})?[KMG]?$/i;
const RETRIES_RE = /^(?:0|[1-9]\d{0,2}|infinite)$/;
/** A `--match-filter` expression: comparisons and boolean operators, no shell metacharacters */
const FILTER_RE = /^[\p{L}\p{N} _.,:=!<>&|()[\]{}'"%@#+*/-]{1,200}$/u;

/**
 * The complete set of yt-dlp flags a per-folder config may pass, each with the
 * shape of its value.
 *
 * This is an allowlist on purpose. A denylist loses to yt-dlp's own parser:
 * `--alias foo "--exec {0}"` expands to an arbitrary flag at run time,
 * clustered short options (`-ia` is `-i` plus `-a`) hide a second flag inside
 * one entry, any unambiguous prefix of a long option resolves to it, and a
 * bare entry is simply another URL to download. None of those spell out
 * `--exec`, and all of them reach either a command or a file, so only exact
 * names of flags that neither run nor read anything are accepted.
 *
 * The set covers what channel configs actually ask for: throttle the channel
 * (`--sleep-*`, `--limit-rate`), cap retries, skip Shorts or live streams
 * (`--match-filter`), keep a single video (`--no-playlist`) and suppress the
 * metadata sidecars the pipeline would otherwise write.
 */
const ALLOWED_EXTRA_ARGS: ReadonlyMap<string, { values: 0 | 1; pattern?: RegExp }> = new Map([
  ['--no-playlist', { values: 0 }],
  ['--no-warnings', { values: 0 }],
  ['--no-write-thumbnail', { values: 0 }],
  ['--no-write-description', { values: 0 }],
  ['--no-write-info-json', { values: 0 }],
  ['--no-write-subs', { values: 0 }],
  ['--no-write-auto-subs', { values: 0 }],
  ['--no-write-comments', { values: 0 }],
  ['--no-write-playlist-metafiles', { values: 0 }],
  ['--sleep-requests', { values: 1, pattern: SECONDS_RE }],
  ['--sleep-interval', { values: 1, pattern: SECONDS_RE }],
  ['--min-sleep-interval', { values: 1, pattern: SECONDS_RE }],
  ['--max-sleep-interval', { values: 1, pattern: SECONDS_RE }],
  ['--limit-rate', { values: 1, pattern: RATE_RE }],
  ['--retries', { values: 1, pattern: RETRIES_RE }],
  ['--match-filter', { values: 1, pattern: FILTER_RE }],
  ['--match-filters', { values: 1, pattern: FILTER_RE }],
]);

/** The allowed names, spelled out in the error a rejected entry produces */
const ALLOWED_FLAG_LIST = [...ALLOWED_EXTRA_ARGS.keys()].join(', ');

interface ExtraArgParse {
  /** Accepted entries, exactly as the config spelled them */
  accepted: string[];
  /** The first problem found, or null when every entry is allowed */
  error: string | null;
}

interface ExtraArgEntry {
  /** The flag part: `--limit-rate=1M` and `--limit-rate` both give `--limit-rate` */
  flag: string;
  /** The value glued with `=`, when the entry has one */
  glued: string | undefined;
  /** The entry as the config spelled it, trimmed */
  text: string;
}

type EntryRead = { ok: true; entry: ExtraArgEntry } | { ok: false; error: string };

/** Split one entry into its flag and glued value, or say why it is unusable */
function readEntry(raw: unknown): EntryRead {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { ok: false, error: `extraArgs contains an invalid argument: ${JSON.stringify(raw)}` };
  }
  const text = raw.trim();
  const equals = text.indexOf('=');
  if (equals === -1) {
    return { ok: true, entry: { flag: text, glued: undefined, text } };
  }
  return { ok: true, entry: { flag: text.slice(0, equals), glued: text.slice(equals + 1), text } };
}

interface EntryCheck {
  /** Entries the check consumes: 1 for a boolean or glued flag, 2 for flag plus value */
  width: number;
  /** Accepted argv entries to keep (empty when the entry is dropped) */
  accepted: string[];
  error?: string;
}

/** Judge a flag that takes a value: the glued one, or the entry after it */
function checkValueFlag(entry: ExtraArgEntry, pattern: RegExp | undefined, next: unknown): EntryCheck {
  const value = entry.glued ?? (typeof next === 'string' ? next : undefined);
  if (value === undefined || value.startsWith('-')) {
    return { width: 1, accepted: [], error: `extraArgs: ${entry.flag} needs a value` };
  }
  if (pattern !== undefined && !pattern.test(value)) {
    return {
      width: entry.glued === undefined ? 2 : 1,
      accepted: [],
      error: `extraArgs: ${entry.flag} has an invalid value: ${JSON.stringify(value)}`,
    };
  }
  return {
    width: entry.glued === undefined ? 2 : 1,
    accepted: entry.glued === undefined ? [value] : [],
  };
}

/** Judge one entry against the allowlist, with the entry that follows it */
function checkEntry(entry: ExtraArgEntry, next: unknown): EntryCheck {
  const spec = ALLOWED_EXTRA_ARGS.get(entry.flag);
  if (spec === undefined) {
    // No arity is known for a rejected flag, so a bare next entry is taken as
    // its value and dropped with it.
    return {
      width: entry.glued === undefined && isBareValue(next) ? 2 : 1,
      accepted: [],
      error: `extraArgs uses an argument that is not allowed: ${entry.flag} (allowed: ${ALLOWED_FLAG_LIST})`,
    };
  }

  if (spec.values === 0) {
    return entry.glued === undefined
      ? { width: 1, accepted: [entry.text] }
      : { width: 1, accepted: [], error: `extraArgs: ${entry.flag} does not take a value` };
  }

  const check = checkValueFlag(entry, spec.pattern, next);
  return check.error === undefined ? { ...check, accepted: [entry.text, ...check.accepted] } : check;
}

/**
 * Read an `extraArgs` list as flag/value pairs. Allowed pairs land in
 * `accepted`; anything else produces the first error and is dropped together
 * with its value, so a caller that sanitizes never leaves an orphan value
 * behind that yt-dlp would read as another URL.
 */
function parseExtraArgs(extraArgs: readonly unknown[]): ExtraArgParse {
  const accepted: string[] = [];
  let error: string | null = null;

  let index = 0;
  while (index < extraArgs.length) {
    const read = readEntry(extraArgs[index]);
    if (!read.ok) {
      error ??= read.error;
      index += 1;
      continue;
    }
    const check = checkEntry(read.entry, extraArgs[index + 1]);
    if (error === null && check.error !== undefined) {
      error = check.error;
    }
    accepted.push(...check.accepted);
    index += check.width;
  }

  return { accepted, error };
}

/** Whether an entry can be the value of the flag before it (not another flag) */
function isBareValue(entry: unknown): boolean {
  return typeof entry === 'string' && entry.trim().length > 0 && !entry.startsWith('-');
}

/**
 * Throwing form of the same check, for the spawn boundary. Config validation
 * and `resolveDownloadOptions` both sanitize already; the queue state file is
 * parsed by hand, so a hand-edited `.queue-state.json` is the one path that
 * can still smuggle an argument in.
 */
export function assertExtraArgsAllowed(extraArgs: readonly string[]): void {
  const { error } = parseExtraArgs(extraArgs);
  if (error !== null) {
    throw new Error(`refusing yt-dlp argument: ${error}`);
  }
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

/** Error message when `value` is not an allowed extraArgs list, or null when it is */
function validateExtraArgs(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return 'extraArgs must be an array of yt-dlp arguments';
  }
  return parseExtraArgs(value).error;
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

/** Error message when `value` is not a folder kind, or null when it is */
function validateKind(value: unknown): string | null {
  return FolderKindSchema.safeParse(value).success ? null : 'kind must be "channel" or "collection"';
}

/** `config.json` fields validated in the order their errors win */
const CONFIG_FIELD_VALIDATORS: Array<[key: string, validate: (value: unknown) => string | null]> = [
  ['kind', validateKind],
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
 * Keep the allowlisted entries of a list that came from disk. A dropped flag
 * takes its value with it, so nothing is left behind for yt-dlp to read as
 * another URL.
 */
function resolveExtraArgs(extraArgs: unknown[]): string[] {
  return parseExtraArgs(extraArgs).accepted;
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
