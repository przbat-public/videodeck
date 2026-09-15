import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';
import { logger } from './utils/logger';

dotenv.config();

/**
 * Every value is read lazily (per call), so importing this module never
 * throws and never pins env values: the server validates at startup and
 * tests can set/clear the environment freely.
 */

export const ELASTICSEARCH_URL = process.env.ELASTICSEARCH_URL || 'http://localhost:9200';

/** Lazily read OpenAI key (only summaries need it) */
export function getOpenAiApiKey(): string | undefined {
  return process.env.OPENAI_API_KEY;
}

/** Bind address of the HTTP server. Loopback by default — see getApiToken. */
export function getHost(): string {
  return process.env.HOST || '127.0.0.1';
}

/**
 * Shared bearer token guarding /api. When unset the API is unauthenticated
 * (single-user local mode) and a warning is logged at startup.
 */
export function getApiToken(): string | undefined {
  return process.env.API_TOKEN;
}

/**
 * When true, open mode is refused: without API_TOKEN every request is 401.
 * Recommended whenever OPENAI_API_KEY is set (summaries cost money) or the
 * server listens on a non-loopback HOST.
 */
export function isTokenRequired(): boolean {
  return process.env.REQUIRE_API_TOKEN === 'true';
}

/**
 * Extra browser origins allowed by CORS, on top of the built-in defaults:
 * the local dev client (localhost on the known dev ports) and Chrome
 * extensions.
 */
export function getCorsOrigins(): string[] {
  return (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

/**
 * Extra hosts accepted in the `Host` header, on top of the loopback defaults
 * (localhost, 127.0.0.1, [::1]). Needed together with `HOST=0.0.0.0` for LAN
 * use: every name/IP the clients will use must be listed, or the server
 * answers 403. This is the DNS-rebinding guard — a malicious domain resolving
 * to 127.0.0.1 sends its own Host header and gets refused.
 */
export function getAllowedHosts(): string[] {
  return (process.env.ALLOWED_HOSTS ?? '')
    .split(',')
    .map((host) => host.trim())
    .filter((host) => host.length > 0);
}

/**
 * Exact `chrome-extension://<id>` origins allowed by CORS. When unset,
 * any Chrome extension may call the API (dev convenience: unpacked
 * extensions get a fresh id per load). When set, only the listed ids can —
 * e.g. `EXTENSION_ORIGINS=chrome-extension://abcdefghijklmnop` after pinning
 * the extension id.
 */
export function getExtensionOrigins(): string[] | undefined {
  const raw = process.env.EXTENSION_ORIGINS ?? '';
  const origins = raw
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  return origins.length > 0 ? origins : undefined;
}

/**
 * Rate limit for the whole HTTP server (requests per window per IP).
 * Generous by default: the client polls the queue every 1.5 s while jobs
 * run. `RATE_LIMIT_MAX`/`RATE_LIMIT_WINDOW_MS` override.
 */
export function getRateLimitMax(): number {
  const parsed = Number.parseInt(process.env.RATE_LIMIT_MAX ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 2000;
}

export function getRateLimitWindowMs(): number {
  const parsed = Number.parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10 * 60 * 1000;
}

// ---------------------------------------------------------------------------
// Video folders
// ---------------------------------------------------------------------------

/**
 * How long an expanded folder list is reused before the disk is re-scanned.
 * The folders live on swappable external drives: a short TTL means a drive
 * mounted while the server runs shows up on the next request.
 */
export const VIDEOS_FOLDER_CACHE_TTL_MS = 10_000;

interface FoldersCache {
  /** Raw VIDEOS_FOLDER_PATH value the entry was built for */
  raw: string;
  readAt: number;
  paths: string[];
}

let foldersCache: FoldersCache | null = null;

/** Drop the cached folder list (tests, config reloads) */
export function invalidateVideosFolderCache(): void {
  foldersCache = null;
}

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

function hasGlobMagic(value: string): boolean {
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

function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Expand a path pattern whose segments may contain `*` (one level each, no
 * `**`). Only existing directories are returned, walking the literal segments
 * first so a pattern rooted at a volume path never descends into a volume
 * that is not mounted.
 */
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

/** Directories matched by one pattern segment below the given bases (async) */
async function expandSegmentAsync(segment: string, bases: readonly string[]): Promise<string[]> {
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

/** The expanded folder list for one raw env value (async — never on the request path) */
async function scanFoldersAsync(raw: string): Promise<string[]> {
  const entries = raw
    .split(/[;,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) {
    throw new Error('VIDEOS_FOLDER_PATH must contain at least one valid folder path');
  }
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const expanded = expandTilde(entry);
    let matches: string[];
    if (hasGlobMagic(expanded)) {
      const candidates = await expandGlobAsync(expanded);
      const filtered: string[] = [];
      for (const folderPath of candidates) {
        if (await isChannelFolderAsync(folderPath)) {
          filtered.push(folderPath);
        }
      }
      matches = filtered.sort();
    } else {
      matches = [expanded];
    }
    for (const folderPath of matches) {
      if (!seen.has(folderPath)) {
        seen.add(folderPath);
        paths.push(folderPath);
      }
    }
  }
  return paths;
}

/** In-flight background rescan (one at a time) */
let folderScanInFlight: Promise<void> | null = null;

/**
 * Re-scan the disk asynchronously and replace the cache. Used when the cache
 * is stale: callers keep getting the previous list while the scan runs, so a
 * slow network drive can no longer block the event loop (the synchronous scan
 * only ever runs on the cold boot path).
 */
async function refreshFoldersCache(raw: string): Promise<void> {
  if (folderScanInFlight) {
    return;
  }
  folderScanInFlight = (async () => {
    try {
      const paths = await scanFoldersAsync(raw);
      if (paths.length === 0) {
        logger.warn(
          'VIDEOS_FOLDER_PATH is set, but no folder matched right now (drive unmounted?). Search and downloads are unavailable until a configured folder appears.',
        );
      }
      foldersCache = { raw, readAt: Date.now(), paths };
    } catch (error) {
      logger.warn(`Background folder rescan failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      folderScanInFlight = null;
    }
  })();
}

/**
 * Get all video folder paths from `VIDEOS_FOLDER_PATH`.
 *
 * Entries are separated by `;` or `,`, `~/` is expanded, and an entry may be
 * a glob pattern (segment-level `*`, e.g. `/Volumes/<disk>/<channel>`) that
 * is expanded to the channel folders that currently exist. This solves the
 * swappable-drive pain: one env line covers every drive, and a drive that is
 * not mounted simply contributes no folders instead of failing validation.
 *
 * The result is cached for a few seconds (disk scan); a configured pattern
 * that matches nothing right now yields an empty list plus a warning — never
 * a hard error, so the server still boots without the drive and picks folders
 * up once it appears. An empty VIDEOS_FOLDER_PATH (config error) still throws.
 */
export function getVideosFolderPaths(): string[] {
  const raw = process.env.VIDEOS_FOLDER_PATH ?? '';
  const cached = foldersCache;
  if (cached !== null && cached.raw === raw) {
    if (Date.now() - cached.readAt < VIDEOS_FOLDER_CACHE_TTL_MS) {
      return cached.paths;
    }
    // Stale: serve the last list and refresh in the background. The scan
    // used to run synchronously on the request path, blocking the event
    // loop for seconds over network drives on every cache expiry.
    void refreshFoldersCache(raw);
    return cached.paths;
  }

  const entries = raw
    .split(/[;,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (entries.length === 0) {
    throw new Error('VIDEOS_FOLDER_PATH must contain at least one valid folder path');
  }

  const paths: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const expanded = expandTilde(entry);
    const matches = hasGlobMagic(expanded) ? expandGlob(expanded).filter(isChannelFolder).sort() : [expanded];
    for (const folderPath of matches) {
      if (!seen.has(folderPath)) {
        seen.add(folderPath);
        paths.push(folderPath);
      }
    }
  }

  if (paths.length === 0) {
    logger.warn(
      'VIDEOS_FOLDER_PATH is set, but no folder matched right now (drive unmounted?). Search and downloads are unavailable until a configured folder appears.',
    );
  }

  foldersCache = { raw, readAt: Date.now(), paths };
  return paths;
}
