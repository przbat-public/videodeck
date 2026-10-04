/**
 * Helpers for tests written under `noUncheckedIndexedAccess`: indexing an
 * array yields `T | undefined`, and a test should fail loudly — not with a
 * `TypeError` three lines later — when the element is missing.
 */
import { type FolderIndex, type FolderIndexEntry, INDEX_VERSION } from './services/folderIndex';

/** Element at `index`, throwing when the array is too short */
export function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`Expected an element at index ${index}, but the array has ${items.length}`);
  }
  return item;
}

/** Value stored under `key`, throwing when the record has no such entry */
export function entry<T>(record: Readonly<Record<string, T>>, key: string): T {
  const value = record[key];
  if (value === undefined) {
    throw new Error(`Expected an entry for ${JSON.stringify(key)}`);
  }
  return value;
}

/**
 * One `.videos-index.json` entry with every field the current version writes,
 * so a test that only cares about `baseName` does not have to spell out the
 * per-file facts. Spread the result and override what the test is about.
 */
export function indexEntry(overrides: Partial<FolderIndexEntry> = {}): FolderIndexEntry {
  return {
    baseName: '20240101_Video',
    videoFile: '20240101_Video.mp4',
    infoMtime: '2024-01-01T00:00:00.000Z',
    subtitleLangs: [],
    hasComments: false,
    hasDescription: false,
    hasThumbnail: false,
    videoBytes: 0,
    infoBytes: 0,
    ...overrides,
  };
}

/** A `.videos-index.json` body holding the ids given, at the current version */
export function indexFile(ids: readonly string[]): FolderIndex {
  const entries: FolderIndex['entries'] = {};
  for (const id of ids) {
    entries[id] = indexEntry({ baseName: `20240101_${id}`, videoFile: `20240101_${id}.mp4` });
  }
  return { version: INDEX_VERSION, builtAt: '2024-01-01T00:00:00.000Z', entries };
}
