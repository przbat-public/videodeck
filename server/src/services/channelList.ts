import fs from 'node:fs/promises';
import path from 'node:path';
import type { ChannelVideo } from '@videodeck/shared/api';
import { errnoCode, isRecord, readString } from '../utils/objectUtils';

/**
 * Reading a channel's `list.json` (written by yt-dlp --flat-playlist) is a
 * data concern, not an HTTP concern — it used to live in the folder routes.
 */

/**
 * `list.json` exists but does not contain a JSON array. A dedicated class so
 * callers can distinguish it from IO/parse failures without string matching.
 */
export class ListJsonError extends Error {
  constructor() {
    super('list.json is not a valid array');
    this.name = 'ListJsonError';
  }
}

/** `20260101` of an id like `20260101_Title`, or undefined when there is none */
function uploadDateOfStem(id: string): string | undefined {
  return /^(\d{8})/.exec(id)?.[1];
}

/** A number field of a catalog entry, or undefined when it is not a number */
function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * One `list.json` entry mapped to the shape the client renders.
 *
 * The optional fields come from whichever source can answer them: a trimmed
 * entry carries them directly, an untrimmed one (written before
 * `trimPlaylistEntries` existed, or by a terminal `yt-dlp -j` run) has the
 * same names in its raw payload. The upload date is not in a flat-playlist
 * dump at all, so it is read from the file stem, which is where yt-dlp's own
 * output template puts it.
 */
export function toChannelVideo(entry: unknown): ChannelVideo {
  const record = isRecord(entry) ? entry : {};
  const id = readString(record.id) ?? '';
  const duration = readNumber(record.duration);
  const viewCount = readNumber(record.viewCount) ?? readNumber(record.view_count);
  const availability = readString(record.availability);
  return {
    title: readString(record.title) ?? '',
    url: readString(record.url) ?? readString(record.webpage_url) ?? '',
    id,
    ...(duration === undefined ? {} : { duration }),
    ...(viewCount === undefined ? {} : { viewCount }),
    ...(availability === undefined ? {} : { availability }),
    ...(uploadDateOfStem(id) === undefined ? {} : { uploadDate: uploadDateOfStem(id) }),
  };
}

/**
 * The keys a `list.json` entry keeps. Everything else a `yt-dlp --flat-playlist`
 * dump carries is playlist bookkeeping (`playlist_index`, `_type`, `ie_key`,
 * `__x_forwarded_for_ip`, …), a thumbnail URL list nobody reads, or a field
 * this app never looks at. A raw dump runs to roughly 13 KB per video, and 40
 * keys per video is what makes opening a channel feel slow.
 */
const CATALOG_KEYS = ['id', 'title', 'url', 'duration', 'viewCount', 'availability'] as const;

/**
 * Trim a raw `yt-dlp --flat-playlist` dump to the catalog this app keeps.
 *
 * Entries without an id are dropped: every consumer matches a video by id, so
 * an entry without one cannot be listed, downloaded or repaired. The keys are
 * written in a fixed order so two fetches of the same channel produce the same
 * file, which makes a diff of `list.json` readable.
 */
export function trimPlaylistEntries(entries: readonly unknown[]): ChannelVideo[] {
  const trimmed: ChannelVideo[] = [];
  for (const entry of entries) {
    const video = toChannelVideo(entry);
    if (video.id.length === 0) {
      continue;
    }
    trimmed.push(video);
  }
  return trimmed;
}

/**
 * A catalog entry as `list.json` stores it. Same fields as `ChannelVideo` and
 * in the same order, so the file reads like the response it feeds.
 */
export function toCatalogEntry(video: ChannelVideo): Record<string, unknown> {
  const entry: Record<string, unknown> = {};
  for (const key of CATALOG_KEYS) {
    const value = video[key];
    if (value !== undefined) {
      entry[key] = value;
    }
  }
  return entry;
}

/**
 * The channel's video list, or null when `list.json` does not exist.
 * Throws for an unreadable file or a non-array JSON (the caller maps those
 * to 400/500 responses).
 */
export async function readListJson(folderPath: string): Promise<ChannelVideo[] | null> {
  const listPath = path.join(folderPath, 'list.json');
  let raw: string;
  try {
    raw = await fs.readFile(listPath, 'utf-8');
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') {
      return null;
    }
    throw error;
  }
  const data: unknown = JSON.parse(raw);
  if (!Array.isArray(data)) {
    throw new ListJsonError();
  }
  return data.map(toChannelVideo);
}
