/**
 * Helpers for tests written under `noUncheckedIndexedAccess`: indexing an
 * array yields `T | undefined`, and a test should fail loudly — not with a
 * `TypeError` three lines later — when the element is missing.
 */

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
