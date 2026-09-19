import { isUpdateStale } from '@videodeck/shared/dates';

/**
 * True when a downloaded video's metadata is older than a month (or unknown).
 *
 * The rule itself lives in `@videodeck/shared/dates`: the server counts stale
 * videos with it for the channel console, and two copies of "a month" would
 * drift.
 */
export const isOlderThanMonth = isUpdateStale;

/** `YYYYMMDD` (yt-dlp upload_date) → `YYYY-MM-DD`; anything else unchanged */
export function formatUploadDate(dateStr: string): string {
  if (dateStr.length !== 8) return dateStr;
  return `${dateStr.substring(0, 4)}-${dateStr.substring(4, 6)}-${dateStr.substring(6, 8)}`;
}

/**
 * How long ago something was updated, in the UI language: "yesterday",
 * "3 days ago". Empty for a missing or unparseable date, so a row can skip it.
 */
export function formatAge(dateString: string | undefined, locale: string, now = Date.now()): string {
  if (!dateString) return '';
  const time = Date.parse(dateString);
  if (Number.isNaN(time)) return '';
  const days = Math.round((time - now) / (24 * 60 * 60 * 1000));
  return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(days, 'day');
}
