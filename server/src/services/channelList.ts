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

/** A `list.json` entry mapped to the shape the client renders */
function toChannelVideo(entry: unknown): ChannelVideo {
  const record = isRecord(entry) ? entry : {};
  return {
    title: readString(record.title) ?? '',
    url: readString(record.url) ?? readString(record.webpage_url) ?? '',
    id: readString(record.id) ?? '',
  };
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
