import fs from 'fs';
import os from 'os';
import path from 'path';
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
 * Extra browser origins allowed by CORS, on top of the built-in defaults:
 * the local dev client (localhost, any port) and Chrome extensions.
 */
export function getCorsOrigins(): string[] {
  return (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
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
function expandGlob(pattern: string): string[] {
  const segments = pattern.split('/').filter((segment) => segment.length > 0);
  let current = [pattern.startsWith('/') ? '/' : '.'];
  for (const segment of segments) {
    const next: string[] = [];
    for (const base of current) {
      if (segment.includes('*')) {
        const matcher = globSegmentToRegExp(segment);
        for (const name of listDirectories(base)) {
          if (matcher.test(name)) {
            next.push(path.join(base, name));
          }
        }
      } else {
        const candidate = path.join(base, segment);
        if (isDirectory(candidate)) {
          next.push(candidate);
        }
      }
    }
    current = next;
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
      .some(
        (entry) =>
          entry.isFile() && (entry.name === 'config.json' || entry.name.endsWith('.info.json'))
      );
  } catch {
    return false;
  }
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
  if (
    cached !== null &&
    cached.raw === raw &&
    Date.now() - cached.readAt < VIDEOS_FOLDER_CACHE_TTL_MS
  ) {
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
    const matches = hasGlobMagic(expanded)
      ? expandGlob(expanded).filter(isChannelFolder).sort()
      : [expanded];
    for (const folderPath of matches) {
      if (!seen.has(folderPath)) {
        seen.add(folderPath);
        paths.push(folderPath);
      }
    }
  }

  if (paths.length === 0) {
    logger.warn(
      'VIDEOS_FOLDER_PATH is set, but no folder matched right now (drive unmounted?). Search and downloads are unavailable until a configured folder appears.'
    );
  }

  foldersCache = { raw, readAt: Date.now(), paths };
  return paths;
}
