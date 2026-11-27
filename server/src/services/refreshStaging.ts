import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { JobType } from '@videodeck/shared/api';
import { logger } from '../utils/logger';
import { describeError } from '../utils/logThrottle';
import { errnoCode, isRecord } from '../utils/objectUtils';
import { extractVideoIdFromHead } from './folderIndex';

/**
 * Metadata refreshes that cannot lose the archive.
 *
 * An `update` job and a comment repair ask yt-dlp for what YouTube serves
 * today, and yt-dlp's default file policy writes that over the archive: the
 * info.json is rewritten whole (comments turned off upstream, a refused comment
 * page, a blanked description all land as they are), and a subtitle or a
 * thumbnail is deleted before it is fetched again, so a 429 leaves it gone.
 * The library is the store of record, and a comment YouTube has deleted
 * cannot be fetched again.
 *
 * So these jobs write into a hidden per-job directory instead, and this module
 * moves the result into place file by file, by rules that only ever add or
 * improve: the comment section is the union of the archived and the fresh one,
 * a field or a file the run did not bring stays as it was, a blank
 * description never replaces a real one, and a file that comes back byte for
 * byte the same is not touched (its mtime is what a cached summary checks).
 * A run that fails leaves the live files exactly as they were.
 */

/** The hidden directory, inside each channel folder, that holds staged runs */
export const STAGING_DIR = '.videodeck-staging';

/**
 * Above this size an info.json is kept as it is rather than merged. The merge
 * holds both parsed files at once; past a few hundred MB that is enough to
 * exhaust the heap, and a job restored after the crash would crash again.
 */
export const MAX_MERGE_INFO_BYTES = 128 * 1024 * 1024;

/** Subtitle formats yt-dlp can write (`--sub-format`), the last part of the name */
const SUBTITLE_EXTENSIONS = ['vtt', 'srt', 'ass', 'ssa', 'ttml', 'json3', 'srv1', 'srv2', 'srv3', 'lrc'];
const SUBTITLE_SUFFIX = new RegExp(`^[\\w-]+(?:\\.[\\w-]+)*\\.(?:${SUBTITLE_EXTENSIONS.join('|')})$`);
const THUMBNAIL_EXTENSIONS = ['webp', 'jpg', 'jpeg', 'png'];

type InfoJson = Record<string, unknown>;

export interface CommitReport {
  /** Live file names the commit wrote */
  committed: string[];
  /** One line per thing the commit kept or dropped, for the job log */
  notes: string[];
}

/** `.videodeck-staging/<jobId>`, relative to the channel folder */
export function stagingPathFor(jobId: string): string {
  return path.join(STAGING_DIR, jobId);
}

/**
 * Whether a job writes into staging. A download writes a stem that is not
 * there yet, and a sidecar repair keeps every file it finds
 * (`--no-overwrites`); the two jobs that rewrite an existing stem with what
 * YouTube returns today are the ones to stage.
 */
export function usesStaging(job: { type: JobType; writeComments?: boolean | undefined }): boolean {
  return job.type === 'update' || (job.type === 'repair' && job.writeComments === true);
}

function isBlank(value: unknown): boolean {
  return typeof value !== 'string' || value.trim() === '';
}

function commentId(comment: unknown): unknown {
  return isRecord(comment) ? comment.id : undefined;
}

/**
 * The fresh copy of a comment, with its archived publish time. YouTube gives
 * only relative times ("3 days ago") and yt-dlp turns them into a timestamp at
 * fetch time, so a later fetch can only estimate the date worse.
 */
function withArchivedPublishTime(fresh: unknown, archived: unknown): unknown {
  if (!isRecord(fresh) || !isRecord(archived) || typeof archived.timestamp !== 'number') {
    return fresh;
  }
  return {
    ...fresh,
    timestamp: archived.timestamp,
    ...(Object.hasOwn(archived, '_time_text') ? { _time_text: archived._time_text } : {}),
  };
}

/**
 * The info.json to keep: the fresh one, with everything it lost put back.
 *
 * - A top-level field the archive has and the fresh run lacks stays: yt-dlp
 *   never writes a null, so a missing key means "not fetched", not "removed".
 * - A missing or blank description never replaces a real one.
 * - The comment section is the fresh list (the fresh copy wins per id, apart
 *   from the publish time), followed by every archived comment YouTube no
 *   longer returned. A run with no comment section keeps the archived one.
 * - `subtitles` (the human tracks YouTube listed) is a union by language: a
 *   human track the archive recorded stays recorded, which is what tells a
 *   later refresh that the file on disk was written by a person.
 *
 * The key order is the fresh one, so the id and the title stay in the head
 * of the file, where the folder index reads them.
 */
export function mergeInfoJson(old: InfoJson, fresh: InfoJson): { merged: InfoJson; notes: string[] } {
  const notes: string[] = [];
  const merged: InfoJson = { ...fresh };
  for (const [key, value] of Object.entries(old)) {
    if (!Object.hasOwn(merged, key)) {
      merged[key] = value;
    }
  }
  if (isBlank(fresh.description) && !isBlank(old.description)) {
    merged.description = old.description;
    notes.push('kept the archived description: the fresh one is blank');
  }
  if (isRecord(old.subtitles) && isRecord(fresh.subtitles)) {
    merged.subtitles = { ...old.subtitles, ...fresh.subtitles };
  }

  const archived = Array.isArray(old.comments) ? old.comments : [];
  if (!Array.isArray(fresh.comments)) {
    if (archived.length > 0) {
      notes.push(`kept ${archived.length} archived comments: the fresh run brought no comment section`);
    }
    return { merged, notes };
  }
  const archivedById = new Map<unknown, unknown>();
  for (const comment of archived) {
    const id = commentId(comment);
    if (id !== undefined) {
      archivedById.set(id, comment);
    }
  }
  const freshIds = new Set<unknown>();
  const comments = fresh.comments.map((comment) => {
    const id = commentId(comment);
    if (id === undefined) {
      return comment;
    }
    freshIds.add(id);
    return archivedById.has(id) ? withArchivedPublishTime(comment, archivedById.get(id)) : comment;
  });
  const archivedOnly = archived.filter((comment) => {
    const id = commentId(comment);
    return id === undefined || !freshIds.has(id);
  });
  merged.comments = [...comments, ...archivedOnly];
  if (archivedOnly.length > 0) {
    notes.push(`kept ${archivedOnly.length} archived comments YouTube no longer returned`);
  }
  return { merged, notes };
}

/** What a staged directory holds, sorted by the rule each file follows */
interface StagedFiles {
  info?: string;
  description?: string;
  subtitles: string[];
  thumbnails: string[];
  /** Committed only where the archive has none: a live chat replay */
  fillOnly: string[];
  /** Partial files (.part, .ytdl, .tmp) and anything the allowlist does not know */
  dropped: string[];
}

function classify(names: string[], stem: string): StagedFiles {
  const staged: StagedFiles = { subtitles: [], thumbnails: [], fillOnly: [], dropped: [] };
  for (const name of [...names].sort()) {
    const rest = name.startsWith(`${stem}.`) ? name.slice(stem.length + 1) : '';
    if (rest === 'info.json') {
      staged.info = name;
    } else if (rest === 'description') {
      staged.description = name;
    } else if (rest === 'live_chat.json') {
      staged.fillOnly.push(name);
    } else if (THUMBNAIL_EXTENSIONS.includes(rest)) {
      staged.thumbnails.push(name);
    } else if (SUBTITLE_SUFFIX.test(rest)) {
      staged.subtitles.push(name);
    } else {
      staged.dropped.push(name);
    }
  }
  return staged;
}

/** The language a subtitle file stands for: `<stem>.<lang>.<ext>` */
function subtitleLanguage(name: string, stem: string): string {
  const rest = name.slice(stem.length + 1);
  return rest.slice(0, rest.lastIndexOf('.'));
}

async function readOrNull(file: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(file);
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false,
  );
}

/**
 * Move a staged file over its live twin unless the two are byte for byte the
 * same. The moved file gets the commit time as its mtime: yt-dlp wrote it
 * earlier, and a summary made from the old subtitle while the job waited for
 * its turn must not read as newer than the subtitle it now describes.
 */
async function replaceIfChanged(stagingDir: string, folderPath: string, name: string): Promise<boolean> {
  const from = path.join(stagingDir, name);
  const to = path.join(folderPath, name);
  const [fresh, current] = await Promise.all([fs.readFile(from), readOrNull(to)]);
  if (current?.equals(fresh)) {
    return false;
  }
  await fs.rename(from, to);
  const now = new Date();
  await fs.utimes(to, now, now);
  return true;
}

async function hasLiveThumbnail(folderPath: string, stem: string): Promise<boolean> {
  const checks = await Promise.all(THUMBNAIL_EXTENSIONS.map((ext) => exists(path.join(folderPath, `${stem}.${ext}`))));
  return checks.includes(true);
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const MIB = 1024 * 1024;

/** Write a file and flush it to the disk before anyone renames it into place */
async function writeDurably(file: string, text: string): Promise<void> {
  const handle = await fs.open(file, 'w');
  try {
    await handle.writeFile(text, 'utf-8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** The archived info.json, as far as the commit may use it */
type LiveInfo =
  | { kind: 'absent' }
  | { kind: 'kept'; reason: string; id?: string }
  | { kind: 'unparseable'; id?: string }
  | { kind: 'parsed'; value: InfoJson; hash: string };

/** The staged info.json */
type FreshInfo =
  | { kind: 'none' }
  | { kind: 'kept'; reason: string; oversized: boolean }
  | { kind: 'parsed'; value: InfoJson };

/** The id at the head of an info.json too large to parse, read from its first bytes */
async function headId(file: string): Promise<string | undefined> {
  const handle = await fs.open(file, 'r');
  try {
    const buffer = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return extractVideoIdFromHead(buffer.subarray(0, bytesRead).toString('utf-8')) ?? undefined;
  } finally {
    await handle.close();
  }
}

/**
 * Read the archived info.json. Only a missing file counts as absent: a read
 * that fails for any other reason (EIO on a failing drive, a file past V8's
 * string limit, a permission) keeps the archive as it is, because treating it
 * as absent would replace every archived comment with today's.
 */
async function readLiveInfo(file: string, maxBytes: number): Promise<LiveInfo> {
  let size: number;
  try {
    const stats = await fs.stat(file);
    if (!stats.isFile()) {
      return { kind: 'kept', reason: 'it is not a regular file' };
    }
    size = stats.size;
  } catch (error) {
    return errnoCode(error) === 'ENOENT' ? { kind: 'absent' } : { kind: 'kept', reason: describeError(error) };
  }
  if (size > maxBytes) {
    const id = await headId(file).catch(() => undefined);
    const reason = `too large to merge safely (${Math.ceil(size / MIB)} MiB)`;
    return id === undefined ? { kind: 'kept', reason } : { kind: 'kept', reason, id };
  }
  let text: string;
  try {
    text = await fs.readFile(file, 'utf-8');
  } catch (error) {
    return { kind: 'kept', reason: describeError(error) };
  }
  try {
    const value: unknown = JSON.parse(text);
    if (isRecord(value)) {
      return { kind: 'parsed', value, hash: sha256(text) };
    }
  } catch {
    // falls through: a truncated file still names its video at its head
  }
  const id = extractVideoIdFromHead(text.slice(0, 8192)) ?? undefined;
  return id === undefined ? { kind: 'unparseable' } : { kind: 'unparseable', id };
}

async function readFreshInfo(file: string | null, maxBytes: number): Promise<FreshInfo> {
  if (file === null) {
    return { kind: 'none' };
  }
  try {
    const { size } = await fs.stat(file);
    if (size > maxBytes) {
      const reason = `the fresh one is too large to merge safely (${Math.ceil(size / MIB)} MiB)`;
      return { kind: 'kept', reason, oversized: true };
    }
    const value: unknown = JSON.parse(await fs.readFile(file, 'utf-8'));
    return isRecord(value)
      ? { kind: 'parsed', value }
      : { kind: 'kept', reason: 'the fresh one is not an object', oversized: false };
  } catch (error) {
    return { kind: 'kept', reason: `the fresh one cannot be read: ${describeError(error)}`, oversized: false };
  }
}

function infoId(info: LiveInfo | FreshInfo): string | undefined {
  if (info.kind === 'parsed') {
    return typeof info.value.id === 'string' ? info.value.id : undefined;
  }
  return (info.kind === 'kept' || info.kind === 'unparseable') && 'id' in info ? info.id : undefined;
}

/**
 * Refuse a commit whose files describe another video. Before the id joined
 * the file name, two videos of one day whose titles sanitized alike shared one
 * restricted name, so the info.json under such an older stem can belong to the
 * other one; merging the two would write a video that never existed, and the
 * union of comments could never undo it.
 */
function assertSameVideo(videoId: string, live: LiveInfo, fresh: FreshInfo): void {
  for (const id of [infoId(live), infoId(fresh)]) {
    if (id !== undefined && id !== videoId) {
      throw new Error(`the info.json under this file name belongs to ${id}, not ${videoId}: kept every file`);
    }
  }
}

/**
 * Languages whose archived subtitle this app kept without knowing its source,
 * recorded in an info.json it took as it was. A later refresh treats them as
 * human tracks: never replaced by machine captions.
 */
const KEPT_SUBTITLES_KEY = '_videodeck_kept_subtitles';

/**
 * Whether the archived `<lang>` file is a human track, as the archived
 * info.json records it (`subtitles` lists what was written by a person), or
 * undefined when there is no readable archived info.json to ask.
 */
function archivedHumanTrack(lang: string, live: LiveInfo): boolean | undefined {
  if (live.kind !== 'parsed') {
    return undefined;
  }
  const kept = live.value[KEPT_SUBTITLES_KEY];
  if (Array.isArray(kept) && kept.includes(lang)) {
    return true;
  }
  return isRecord(live.value.subtitles) && Object.hasOwn(live.value.subtitles, lang);
}

/**
 * Whether the staged `<lang>` file is a human track. yt-dlp writes a human
 * track only when the run asked for them (a folder's `--no-write-subs` turns
 * that off) and YouTube still lists one; otherwise the file under that name
 * is machine captions. Undefined without a readable fresh info.json.
 */
function stagedHumanTrack(lang: string, fresh: FreshInfo, requestsHuman: boolean): boolean | undefined {
  if (!requestsHuman) {
    return false;
  }
  if (fresh.kind !== 'parsed') {
    return undefined;
  }
  return isRecord(fresh.value.subtitles) && Object.hasOwn(fresh.value.subtitles, lang);
}

/**
 * Whether a staged subtitle may replace the archived one. Anything may
 * replace machine captions; an archived human track is replaced only by a
 * human track. Once the human track is gone upstream yt-dlp writes the
 * automatic one under the same name, which is the replacement this refuses.
 * An archived subtitle whose source cannot be told stays as well.
 */
function subtitleVerdict(lang: string, target: CommitTarget): 'replace' | 'keep-human' | 'keep-unknown' {
  const archived = archivedHumanTrack(lang, target.live);
  if (archived === false) {
    return 'replace';
  }
  if (archived === undefined) {
    return 'keep-unknown';
  }
  return stagedHumanTrack(lang, target.fresh, target.requestsHumanSubtitles) === true ? 'replace' : 'keep-human';
}

/** Where a commit reads from and writes to, and what it learned from the two info.json files */
interface CommitTarget {
  stagingDir: string;
  folderPath: string;
  stem: string;
  live: LiveInfo;
  fresh: FreshInfo;
  /** Whether the run asked yt-dlp for human tracks (no `--no-write-subs`) */
  requestsHumanSubtitles: boolean;
  /** Languages whose archived subtitle stayed because its source could not be told */
  keptUnknown: string[];
}

async function commitSubtitle(target: CommitTarget, name: string, report: CommitReport) {
  if (await exists(path.join(target.folderPath, name))) {
    const lang = subtitleLanguage(name, target.stem);
    const verdict = subtitleVerdict(lang, target);
    if (verdict === 'keep-human') {
      report.notes.push(`kept the archived ${lang} subtitle: a person wrote it, and this run brought machine captions`);
      return;
    }
    if (verdict === 'keep-unknown') {
      target.keptUnknown.push(lang);
      report.notes.push(
        `kept the archived ${lang} subtitle: with no readable archived info.json its source cannot be told`,
      );
      return;
    }
  }
  if (await replaceIfChanged(target.stagingDir, target.folderPath, name)) {
    report.committed.push(name);
  }
}

async function commitDescription(target: CommitTarget, name: string | undefined, report: CommitReport) {
  if (name === undefined) {
    return;
  }
  const body = await fs.readFile(path.join(target.stagingDir, name), 'utf-8');
  if (body.trim() === '') {
    report.notes.push('kept the archived description file: the fresh one is blank');
  } else if (await replaceIfChanged(target.stagingDir, target.folderPath, name)) {
    report.committed.push(name);
  }
}

/**
 * An archived thumbnail stays. A refresh cannot tell a better image from a
 * fallback: after a 429 on the best candidates yt-dlp writes a worse one
 * under the same name, and a cut transfer leaves a truncated file. Only a
 * video that has none gets the staged one. The file route counts on this
 * too: it lets browsers keep a thumbnail for a year without asking again
 * (routes/videos/files.ts), so new bytes under an old name would never
 * reach a browser that had cached it.
 */
async function commitThumbnail(target: CommitTarget, names: string[], report: CommitReport) {
  const [thumbnail] = names;
  if (thumbnail === undefined || (await hasLiveThumbnail(target.folderPath, target.stem))) {
    return;
  }
  await fs.rename(path.join(target.stagingDir, thumbnail), path.join(target.folderPath, thumbnail));
  report.committed.push(thumbnail);
}

async function commitFillOnly(target: CommitTarget, names: string[], report: CommitReport) {
  for (const name of names) {
    if (!(await exists(path.join(target.folderPath, name)))) {
      await fs.rename(path.join(target.stagingDir, name), path.join(target.folderPath, name));
      report.committed.push(name);
    }
  }
}

/**
 * Put the staged info.json in place as it is: there is no archive to merge
 * it with. The subtitles this commit kept without knowing their source are
 * recorded in it, so the next refresh keeps them as well.
 */
async function takeFresh(target: CommitTarget, name: string, report: CommitReport): Promise<void> {
  const livePath = path.join(target.folderPath, name);
  if (target.keptUnknown.length > 0 && target.fresh.kind === 'parsed') {
    const recorded = target.fresh.value[KEPT_SUBTITLES_KEY];
    const kept = [...new Set([...(Array.isArray(recorded) ? recorded : []), ...target.keptUnknown])];
    const tempPath = path.join(target.stagingDir, `${name}.merged`);
    await writeDurably(tempPath, JSON.stringify({ ...target.fresh.value, [KEPT_SUBTITLES_KEY]: kept }));
    await fs.rename(tempPath, livePath);
  } else {
    await fs.rename(path.join(target.stagingDir, name), livePath);
  }
  report.committed.push(name);
}

/** Last, the way yt-dlp writes it: the post-job refresh keys on this file */
async function commitInfo(target: CommitTarget, name: string | undefined, report: CommitReport) {
  const { live, fresh } = target;
  if (name === undefined || fresh.kind === 'none') {
    return;
  }
  if (fresh.kind === 'kept') {
    // The size cap protects a merge; with no archive there is nothing to merge
    if (live.kind === 'absent' && fresh.oversized) {
      await takeFresh(target, name, report);
      return;
    }
    report.notes.push(
      live.kind === 'absent'
        ? `did not take the fresh info.json: ${fresh.reason}`
        : `kept the archived info.json: ${fresh.reason}`,
    );
    return;
  }
  if (live.kind === 'kept') {
    report.notes.push(`kept the archived info.json: ${live.reason}; the video stays as stale as it was`);
    return;
  }
  if (live.kind === 'absent') {
    await takeFresh(target, name, report);
    return;
  }
  const livePath = path.join(target.folderPath, name);
  if (live.kind === 'unparseable') {
    // Its bytes stay on disk under another name, and the video becomes
    // readable again: nothing else can repair a file that does not parse. A
    // copy first, then the swap, so the name never goes without an info.json.
    const aside = `${name}.unparseable-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    await fs.copyFile(livePath, path.join(target.folderPath, aside), fsConstants.COPYFILE_EXCL);
    await takeFresh(target, name, report);
    report.notes.push(`the archived info.json did not parse: copied it aside to ${aside} and took the fresh one`);
    return;
  }
  const { merged, notes } = mergeInfoJson(live.value, fresh.value);
  report.notes.push(...notes);
  const text = JSON.stringify(merged);
  if (sha256(text) === live.hash) {
    return;
  }
  // Written inside the staging directory, flushed, then renamed over the
  // live file (same filesystem, so the swap is atomic): a crash mid-write
  // leaves its leftover where the staging cleanup removes it, and the merged
  // file can be the only copy left of comments YouTube no longer serves.
  const tempPath = path.join(target.stagingDir, `${name}.merged`);
  await writeDurably(tempPath, text);
  await fs.rename(tempPath, livePath);
  report.committed.push(name);
}

async function applyStaged(target: CommitTarget, staged: StagedFiles): Promise<CommitReport> {
  const report: CommitReport = { committed: [], notes: [] };
  for (const name of staged.subtitles) {
    await commitSubtitle(target, name, report);
  }
  await commitDescription(target, staged.description, report);
  await commitThumbnail(target, staged.thumbnails, report);
  await commitFillOnly(target, staged.fillOnly, report);
  await commitInfo(target, staged.info, report);
  if (staged.dropped.length > 0) {
    report.notes.push(`dropped ${staged.dropped.join(', ')}: not a finished sidecar`);
  }
  return report;
}

/** The names in a staging directory, or null when yt-dlp created none */
async function readStagedNames(stagingDir: string): Promise<string[] | null> {
  try {
    return await fs.readdir(stagingDir);
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') {
      // yt-dlp creates nothing for a run its filters skip
      return null;
    }
    throw error;
  }
}

/**
 * Whether the staging parent is a real directory, or not there at all. A
 * symlink in its place would point every read, rename and removal of a staged
 * run at wherever the link leads.
 */
async function stagingParentIsSafe(folderPath: string): Promise<boolean> {
  try {
    return (await fs.lstat(path.join(folderPath, STAGING_DIR))).isDirectory();
  } catch (error) {
    return errnoCode(error) === 'ENOENT';
  }
}

async function commitNow(options: CommitOptions): Promise<CommitReport> {
  const {
    folderPath,
    jobId,
    stem,
    videoId,
    maxInfoBytes = MAX_MERGE_INFO_BYTES,
    requestsHumanSubtitles = true,
  } = options;
  if (!(await stagingParentIsSafe(folderPath))) {
    throw new Error(`${STAGING_DIR} is not a plain directory: refusing to read or move anything through it`);
  }
  const stagingDir = path.join(folderPath, stagingPathFor(jobId));
  const names = await readStagedNames(stagingDir);
  if (names === null) {
    return { committed: [], notes: [] };
  }
  try {
    const staged = classify(names, stem);
    const live = await readLiveInfo(path.join(folderPath, `${stem}.info.json`), maxInfoBytes);
    const fresh = await readFreshInfo(
      staged.info === undefined ? null : path.join(stagingDir, staged.info),
      maxInfoBytes,
    );
    assertSameVideo(videoId, live, fresh);
    return await applyStaged(
      { stagingDir, folderPath, stem, live, fresh, requestsHumanSubtitles, keptUnknown: [] },
      staged,
    );
  } finally {
    await fs.rm(stagingDir, { recursive: true, force: true });
  }
}

export interface CommitOptions {
  folderPath: string;
  jobId: string;
  stem: string;
  /** The job's video: a staged or archived info.json naming another one stops the commit */
  videoId: string;
  /**
   * Whether the run asked yt-dlp for human subtitle tracks. A folder's
   * `--no-write-subs` turns them off, and yt-dlp then writes machine captions
   * under the name of a human track the archive holds. Default true.
   */
  requestsHumanSubtitles?: boolean;
  /** Tests: the size above which an info.json is kept rather than merged */
  maxInfoBytes?: number;
}

/**
 * One commit at a time, across every folder: parsing and serializing an
 * info.json of a comment-heavy video blocks the event loop and holds the
 * heap, and the hook chains that call this run per folder.
 */
let commitChain: Promise<unknown> = Promise.resolve();

/**
 * Move a staged run into the channel folder, by the rules in the module
 * header, and remove the staging directory. A missing staging directory is a
 * run that staged nothing.
 */
export function commitStagedRefresh(options: CommitOptions): Promise<CommitReport> {
  const run = commitChain.then(() => commitNow(options));
  commitChain = run.catch(() => undefined);
  return run;
}

/**
 * Whether yt-dlp cut the comment extraction short in a staged run. Under -i a
 * refused comment page ends the run with exit 1, yet the info.json is written
 * with the comments that did arrive, and without `comment_count` (yt-dlp sets
 * it only for a complete extraction). Merged by id, such a list loses nothing.
 */
export async function stagedCommentsInterrupted(folderPath: string, jobId: string, stem: string): Promise<boolean> {
  const file = path.join(folderPath, stagingPathFor(jobId), `${stem}.info.json`);
  try {
    if ((await fs.stat(file)).size > MAX_MERGE_INFO_BYTES) {
      return false;
    }
    const info: unknown = JSON.parse(await fs.readFile(file, 'utf-8'));
    return isRecord(info) && Array.isArray(info.comments) && !Object.hasOwn(info, 'comment_count');
  } catch {
    return false;
  }
}

/**
 * Remove a job's staging directory, and with it the leftovers of jobs this
 * process no longer runs (a staged run interrupted by a crash, on a drive that
 * was away at boot). The parent stays: another job may be about to write into it.
 */
export async function removeStaging(
  folderPath: string,
  jobId: string,
  activeIds: ReadonlySet<string> = new Set(),
): Promise<void> {
  if (!(await stagingParentIsSafe(folderPath))) {
    // Never list or remove through a link: that would empty its target
    return;
  }
  const parent = path.join(folderPath, STAGING_DIR);
  await fs.rm(path.join(parent, jobId), { recursive: true, force: true });
  let entries: string[];
  try {
    entries = await fs.readdir(parent);
  } catch {
    return;
  }
  await Promise.all(
    entries
      .filter((entry) => !activeIds.has(entry))
      .map((entry) => fs.rm(path.join(parent, entry), { recursive: true, force: true })),
  );
}

/**
 * Boot, before any job runs: every staged run left over belongs to a dead
 * process. Best effort: a leftover the server cannot remove (a drive the
 * kernel remounted read-only, a directory another user owns) is logged and
 * left, and the server still boots. A symlink in its place is removed as a
 * link, never followed.
 */
export async function sweepStagingDirs(folderPaths: readonly string[]): Promise<void> {
  await Promise.all(
    folderPaths.map((folderPath) =>
      fs.rm(path.join(folderPath, STAGING_DIR), { recursive: true, force: true }).catch((error: unknown) => {
        logger.warn(`Could not remove ${STAGING_DIR} in ${folderPath}: ${describeError(error)}`);
      }),
    ),
  );
}
