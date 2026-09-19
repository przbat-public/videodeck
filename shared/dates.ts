/**
 * How long a downloaded video may go without a metadata refresh. The client
 * marks a row as stale with it and the server counts stale videos for the
 * channel console, so the rule lives in one place instead of two that drift.
 */
export const UPDATE_STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

/** True when a downloaded video's metadata is older than a month (or unknown) */
export function isUpdateStale(lastUpdated: string | undefined, now: number = Date.now()): boolean {
  if (!lastUpdated) {
    return true;
  }
  const updated = Date.parse(lastUpdated);
  if (Number.isNaN(updated)) {
    return true;
  }
  return now - updated >= UPDATE_STALE_AFTER_MS;
}
