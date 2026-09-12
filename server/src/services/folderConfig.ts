import fs from 'fs/promises';
import path from 'path';
import type { DownloadOptions, FolderConfig } from '@shared/api';

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
