import fs from 'node:fs/promises';
import path from 'node:path';
import { listVisibleFiles, writeTextAtomic } from '../utils/fsUtils';
import { ARCHIVE_FILE, type FolderIndex } from './folderIndex';

/**
 * `archive.txt` as a file the app can read, verify and repair.
 *
 * The file is yt-dlp's record of "already downloaded", one `youtube <id>` line
 * per video, and plain yt-dlp runs share it with us. It is also the only place
 * that can disagree with the disk without anybody noticing: delete a video and
 * its line stays, so a later download skips a video that is no longer there.
 *
 * Everything here follows one rule: the disk decides. The archive is rewritten
 * from the folder index, never the other way around, and never while the folder
 * looks like an unmounted drive.
 */

/** What the archive and the disk disagree about */
export interface ArchiveDrift {
  /** On disk, absent from `archive.txt` */
  missingFromArchive: string[];
  /** In `archive.txt`, absent from the disk */
  missingFromDisk: string[];
}

export type ArchiveMethod = 'add' | 'remove' | 'rebuild';

export interface ReconcileResult {
  /** Lines added to `archive.txt` */
  added: string[];
  /** Lines removed from `archive.txt` */
  removed: string[];
  /** Ids left untouched */
  unchanged: number;
}

export function archiveDrift(index: FolderIndex, archiveIds: ReadonlySet<string>): ArchiveDrift {
  const onDisk = Object.keys(index.entries);
  return {
    missingFromArchive: onDisk.filter((id) => !archiveIds.has(id)).sort((a, b) => a.localeCompare(b)),
    missingFromDisk: [...archiveIds].filter((id) => index.entries[id] === undefined).sort((a, b) => a.localeCompare(b)),
  };
}

/**
 * Current `archive.txt` of a folder, as a set of video ids.
 *
 * The parse lives here rather than being borrowed from `folderIndex`: that
 * module rebuilds the file, this one verifies it, and a route that only wants
 * to compare the two should not pull in the index writer to do it.
 *
 * A line is `<extractor> <id>`, the shape yt-dlp appends. Anything shorter is
 * ignored, which is also what a half-written last line looks like.
 */
export async function readArchive(folderPath: string): Promise<Set<string>> {
  let raw: string;
  try {
    raw = await fs.readFile(archivePath(folderPath), 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return new Set();
    }
    throw error;
  }
  const ids = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    const [, id] = line.trim().split(/\s+/);
    if (id) {
      ids.add(id);
    }
  }
  return ids;
}

/**
 * Whether the folder looks like a mounted library right now.
 *
 * The archive is a file we may empty, and an unmounted drive makes a folder
 * look empty: reconciling then would drop every line and send the next download
 * run over the whole channel again. The same guard the index sweep uses.
 */
export async function folderLooksPresent(folderPath: string): Promise<boolean> {
  const files = await listVisibleFiles(folderPath).catch(() => []);
  return files.some((file) => file.endsWith('.info.json'));
}

function refuseUnmounted(): never {
  throw new Error(`refusing to touch ${ARCHIVE_FILE}: the folder holds no .info.json, so the drive looks unmounted`);
}

/** Accumulates the diff while a plan is built, so each method reads as a rule */
class ArchivePlan {
  private readonly current: Set<string>;
  readonly added: string[] = [];
  readonly removed: string[] = [];

  constructor(archiveIds: ReadonlySet<string>) {
    this.current = new Set(archiveIds);
  }

  add(id: string): void {
    if (!this.current.has(id)) {
      this.current.add(id);
      this.added.push(id);
    }
  }

  remove(id: string): void {
    if (this.current.delete(id)) {
      this.removed.push(id);
    }
  }

  /** Ids currently planned, unsorted */
  ids(): string[] {
    return [...this.current];
  }

  result(): { next: string[]; added: string[]; removed: string[] } {
    const sorted = (ids: string[]): string[] => [...ids].sort((a, b) => a.localeCompare(b));
    return { next: sorted(this.ids()), added: sorted(this.added), removed: sorted(this.removed) };
  }
}

/** `add`: record the ids named, or every id on disk when none are named */
function planAdd(plan: ArchivePlan, onDiskIds: readonly string[], videoIds: readonly string[]): void {
  for (const id of videoIds.length > 0 ? videoIds : onDiskIds) {
    plan.add(id);
  }
}

/**
 * `remove`: forget the ids named. Without ids it drops the lines the disk
 * cannot back up, which is the "clean up after deleted files" sweep; naming an
 * id is the operator saying so, and that works while a drive is away.
 */
function planRemove(plan: ArchivePlan, disk: ReadonlySet<string>, videoIds: readonly string[]): void {
  if (videoIds.length > 0) {
    for (const id of videoIds) {
      plan.remove(id);
    }
    return;
  }
  for (const id of plan.ids()) {
    if (!disk.has(id)) {
      plan.remove(id);
    }
  }
}

/** `rebuild`: the disk is the whole truth, in both directions */
function planRebuild(plan: ArchivePlan, disk: ReadonlySet<string>, onDiskIds: readonly string[]): void {
  for (const id of plan.ids()) {
    if (!disk.has(id)) {
      plan.remove(id);
    }
  }
  for (const id of onDiskIds) {
    plan.add(id);
  }
}

/** The lines `archive.txt` should hold after reconciling, and the diff */
export function planArchive(
  method: ArchiveMethod,
  onDiskIds: readonly string[],
  archiveIds: ReadonlySet<string>,
  videoIds: readonly string[] = [],
): { next: string[]; added: string[]; removed: string[] } {
  const plan = new ArchivePlan(archiveIds);
  const disk = new Set(onDiskIds);

  if (method === 'add') {
    planAdd(plan, onDiskIds, videoIds);
  } else if (method === 'remove') {
    planRemove(plan, disk, videoIds);
  } else {
    planRebuild(plan, disk, onDiskIds);
  }

  return plan.result();
}

/**
 * Bring `archive.txt` in line with the disk (or with the ids the caller names)
 * and report what changed.
 *
 * `rebuild` and a bare `remove` follow the disk, so both refuse to run when the
 * folder holds no `.info.json`: that is how an absent drive looks, and an
 * archive emptied by an absent drive re-downloads a whole channel.
 */
export async function reconcileArchive(
  folderPath: string,
  method: ArchiveMethod,
  index: FolderIndex,
  videoIds: readonly string[] = [],
): Promise<ReconcileResult> {
  const archiveIds = await readArchive(folderPath);
  const onDiskIds = Object.keys(index.entries);
  const followsDisk = method === 'rebuild' || (method === 'remove' && videoIds.length === 0);
  if (followsDisk && onDiskIds.length === 0 && !(await folderLooksPresent(folderPath))) {
    refuseUnmounted();
  }

  const plan = planArchive(method, onDiskIds, archiveIds, videoIds);
  if (plan.added.length > 0 || plan.removed.length > 0) {
    const content = plan.next.length > 0 ? `${plan.next.map((id) => `youtube ${id}`).join('\n')}\n` : '';
    await writeTextAtomic(path.join(folderPath, ARCHIVE_FILE), content);
  }
  return { added: plan.added, removed: plan.removed, unchanged: plan.next.length - plan.added.length };
}

/** The archive file of a folder, for callers that need the path only */
export function archivePath(folderPath: string): string {
  return path.join(folderPath, ARCHIVE_FILE);
}
