const ONE_MONTH_MS = 30 * 24 * 60 * 60 * 1000;

/** True when a downloaded video's metadata is older than a month (or unknown) */
export const isOlderThanMonth = (lastUpdated: string | undefined, now = Date.now()): boolean => {
  if (!lastUpdated) return true;
  const updated = new Date(lastUpdated).getTime();
  if (Number.isNaN(updated)) return true;
  return now - updated >= ONE_MONTH_MS;
};

/** `YYYYMMDD` (yt-dlp upload_date) → `YYYY-MM-DD`; anything else unchanged */
export function formatUploadDate(dateStr: string): string {
  if (!dateStr || dateStr.length !== 8) return dateStr;
  return `${dateStr.substring(0, 4)}-${dateStr.substring(4, 6)}-${dateStr.substring(6, 8)}`;
}
