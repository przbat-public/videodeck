const ONE_MONTH_MS = 30 * 24 * 60 * 60 * 1000;

/** True when a downloaded video's metadata is older than a month (or unknown) */
export const isOlderThanMonth = (lastUpdated: string | undefined, now = Date.now()): boolean => {
  if (!lastUpdated) return true;
  const updated = new Date(lastUpdated).getTime();
  if (Number.isNaN(updated)) return true;
  return now - updated >= ONE_MONTH_MS;
};
