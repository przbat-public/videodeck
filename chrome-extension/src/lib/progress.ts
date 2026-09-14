/**
 * Extract the download progress percentage from a yt-dlp output line, e.g.
 * `[download]  45.2% of 123.45MiB at 1.23MiB/s ETA 00:45`. Returns undefined
 * when the line carries no percentage.
 */
export function extractProgress(message: string): number | undefined {
  // Capture the sign too, so a stray negative value clamps to 0 below
  const percentMatch = message.match(/(-?\d+\.?\d*)%/);
  if (percentMatch?.[1] !== undefined) {
    return Math.min(100, Math.max(0, parseFloat(percentMatch[1])));
  }

  // If the message says "100%" or "completed" (in any wording the regex above
  // did not catch), report the download as finished.
  const lower = message.toLowerCase();
  if (lower.includes('100%') || lower.includes('completed')) {
    return 100;
  }

  return undefined;
}
