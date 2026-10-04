import fs from 'node:fs/promises';
import path from 'node:path';
import { UPDATE_STALE_AFTER_MS } from '@videodeck/shared/dates';
import { isYoutubeVideoId } from '@videodeck/shared/youtube';
import { writeJsonAtomic } from '../utils/fsUtils';
import { logger } from '../utils/logger';
import { errnoCode, isRecord, readString } from '../utils/objectUtils';

/**
 * Videos YouTube will not hand over, and the queue's memory of the ones that
 * already refused.
 *
 * Two sources answer "can this download succeed": the catalog, which carries
 * the `availability` yt-dlp reported for the channel listing, and the record
 * this module keeps of failures observed on this machine. Neither is a guess
 * about the network. The catalog says a video is members-only or Premium-only,
 * and a recorded failure says yt-dlp already tried and lost for a reason that
 * waiting cannot fix.
 *
 * The record lives in the media folder as `.unavailable.json`, next to
 * `.videos-index.json` and `archive.txt`: it describes that folder, and a drive
 * that moves to another machine takes it along. It is derived state, so a
 * corrupt file is dropped and rebuilt rather than reported.
 *
 * The queue reads this module, so nothing here may throw at it: a folder that
 * cannot be read answers "nothing known" and the download keeps its normal
 * path.
 */

/** The record file, kept out of the way of the videos themselves */
export const UNAVAILABLE_FILE = '.unavailable.json';
/** Shape version of the record; a different version starts the folder over */
export const UNAVAILABLE_VERSION = 1;
/**
 * How long a recorded failure suppresses the next attempt. It matches the
 * staleness window of a metadata refresh: a month later the video gets one
 * fresh try, which is also when a membership or a region block may have
 * changed.
 */
export const UNAVAILABLE_TTL_MS = UPDATE_STALE_AFTER_MS;

/**
 * The failure codes that describe the video rather than the machine. A full
 * disk or a bot wall says nothing about the video, so those never enter the
 * record: the next attempt may well succeed.
 */
export const REMEMBERED_FAILURE_CODES = ['members-only', 'private', 'removed', 'geo-restricted', 'age-gate'] as const;

export type RememberedFailureCode = (typeof REMEMBERED_FAILURE_CODES)[number];

/** What the queue tells the client when it refuses to build a job */
export type SkipReason = RememberedFailureCode | 'premium-only';

export interface UnavailableEntry {
  code: RememberedFailureCode;
  /** When the failure was observed, ISO */
  at: string;
}

export interface UnavailableRecord {
  version: 1;
  entries: Record<string, UnavailableEntry>;
}

/**
 * Availability values that no anonymous download can pass. `needs_auth` and
 * `private` stay out on purpose: they are rarer, their metadata is less
 * reliable, and a real attempt that fails lands in the record anyway.
 */
const UNFETCHABLE_AVAILABILITIES: ReadonlyMap<string, SkipReason> = new Map<string, SkipReason>([
  ['subscriber_only', 'members-only'],
  ['premium_only', 'premium-only'],
]);

/** The skip reason the catalog implies for this availability, or null */
export function availabilitySkipReason(availability: string | undefined): SkipReason | null {
  if (availability === undefined) {
    return null;
  }
  return UNFETCHABLE_AVAILABILITIES.get(availability) ?? null;
}

/** Whether a failure code belongs in the record */
export function isRememberedFailure(code: string): code is RememberedFailureCode {
  return (REMEMBERED_FAILURE_CODES as readonly string[]).includes(code);
}

/** Whether an entry is recent enough to suppress a new attempt */
export function isEntryFresh(entry: UnavailableEntry, now: number): boolean {
  const at = Date.parse(entry.at);
  if (Number.isNaN(at)) {
    return false;
  }
  return now - at < UNAVAILABLE_TTL_MS;
}

export interface SkipDecisionInput {
  /** The catalog's `availability` for this video, when the folder has one */
  availability: string | undefined;
  /**
   * What the folder's record holds for this video, when it holds anything. The
   * code is a plain string because the file it comes from is editable by hand:
   * `readUnavailable` already drops the codes it does not know, and this check
   * keeps the decision honest for any other caller.
   */
  recorded: { code: string; at: string } | undefined;
  now: number;
}

/**
 * Why this video cannot be downloaded, or null when nothing is known against
 * it. The catalog wins over the record: a members-only badge is a statement
 * about the present, while the record is a statement about one past attempt.
 */
export function unavailableSkipReason(input: SkipDecisionInput): SkipReason | null {
  const fromCatalog = availabilitySkipReason(input.availability);
  if (fromCatalog !== null) {
    return fromCatalog;
  }
  const recorded = input.recorded;
  if (recorded === undefined || !isEntryFresh(recorded, input.now)) {
    return null;
  }
  return isRememberedFailure(recorded.code) ? recorded.code : null;
}

/** An empty record: what a folder without one, or with a broken one, answers */
function emptyRecord(): UnavailableRecord {
  return { version: UNAVAILABLE_VERSION, entries: {} };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One stored entry, or null when a hand-edited file wrote something else */
function readEntry(value: unknown): UnavailableEntry | null {
  if (!isRecord(value)) {
    return null;
  }
  const code = readString(value.code);
  const at = readString(value.at);
  if (code === undefined || at === undefined || !isRememberedFailure(code)) {
    return null;
  }
  if (Number.isNaN(Date.parse(at))) {
    return null;
  }
  return { code, at };
}

/**
 * The folder's record. A missing file is the normal case for a folder that
 * never had a permanent failure; an unreadable or corrupt one answers the same
 * way, because the record can be rebuilt by the next failure.
 */
export async function readUnavailable(folderPath: string): Promise<UnavailableRecord> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(folderPath, UNAVAILABLE_FILE), 'utf-8');
  } catch (error) {
    if (errnoCode(error) !== 'ENOENT') {
      logger.warn(`Cannot read ${UNAVAILABLE_FILE} in ${folderPath}: ${messageOf(error)}`);
    }
    return emptyRecord();
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    logger.warn(`Ignoring ${UNAVAILABLE_FILE} in ${folderPath}: not valid JSON`);
    return emptyRecord();
  }
  if (!isRecord(data) || !isRecord(data.entries)) {
    logger.warn(`Ignoring ${UNAVAILABLE_FILE} in ${folderPath}: unexpected shape`);
    return emptyRecord();
  }

  const entries: Record<string, UnavailableEntry> = {};
  for (const [videoId, value] of Object.entries(data.entries)) {
    const entry = readEntry(value);
    // The id becomes a key the skip decision matches against, so it has to look
    // like a video id: a hand-edited file must not let anything else through.
    if (entry !== null && isYoutubeVideoId(videoId)) {
      entries[videoId] = entry;
    }
  }
  return { version: UNAVAILABLE_VERSION, entries };
}

/**
 * Writes of one folder, chained. Several jobs of a folder can finish at the
 * same moment, and each write is a read-modify-write of the whole file: without
 * the chain the slower writer would drop the other's entry.
 */
const writeChains = new Map<string, Promise<void>>();

function queuedWrite(folderPath: string, task: () => Promise<void>): Promise<void> {
  const previous = writeChains.get(folderPath) ?? Promise.resolve();
  const settled = previous.then(task, task).catch((error: unknown) => {
    logger.warn(`Cannot update ${UNAVAILABLE_FILE} in ${folderPath}: ${messageOf(error)}`);
  });
  writeChains.set(folderPath, settled);
  return settled;
}

/**
 * Remember that these videos failed for a reason waiting cannot fix. Codes and
 * ids outside the known shapes are dropped, so a caller cannot turn the record
 * into a place where arbitrary text lives.
 */
export async function recordUnavailable(
  folderPath: string,
  videoIds: readonly string[],
  code: string,
  now: number = Date.now(),
): Promise<void> {
  if (!isRememberedFailure(code)) {
    return;
  }
  const ids = videoIds.filter(isYoutubeVideoId);
  if (ids.length === 0) {
    return;
  }
  await queuedWrite(folderPath, async () => {
    const record = await readUnavailable(folderPath);
    const at = new Date(now).toISOString();
    for (const videoId of ids) {
      record.entries[videoId] = { code, at };
    }
    await writeJsonAtomic(folderPath, UNAVAILABLE_FILE, record);
  });
}

/**
 * Forget these videos, which is what a successful download does: the file a
 * force or a renewed membership produced must not stay suppressed by an old
 * verdict.
 */
export async function clearUnavailable(folderPath: string, videoIds: readonly string[]): Promise<void> {
  const ids = new Set(videoIds.filter(isYoutubeVideoId));
  if (ids.size === 0) {
    return;
  }
  await queuedWrite(folderPath, async () => {
    const record = await readUnavailable(folderPath);
    const kept: Record<string, UnavailableEntry> = {};
    let dropped = false;
    for (const [videoId, entry] of Object.entries(record.entries)) {
      if (ids.has(videoId)) {
        dropped = true;
        continue;
      }
      kept[videoId] = entry;
    }
    // A folder with nothing recorded keeps no file: the next read would answer
    // the same, and an empty file would only be one more thing to explain.
    if (!dropped) {
      return;
    }
    await writeJsonAtomic(folderPath, UNAVAILABLE_FILE, { version: UNAVAILABLE_VERSION, entries: kept });
  });
}
