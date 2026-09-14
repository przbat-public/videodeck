/**
 * Runtime helpers shared by the server (download queue log parsing) and the
 * Chrome extension (SSE output parsing). Unlike api.ts, this module is
 * imported for real — the ESLint restricted-import rule only protects api.ts.
 */

/**
 * Extract the download progress percentage from a yt-dlp output line.
 * Understands two formats:
 *  1. our `--progress-template` line: `download  45.2% (123MiB @ 1MiB/s, ETA 00:45)`
 *  2. the default yt-dlp bar: `[download]  45.2% of 123.45MiB at 1.23MiB/s ETA 00:45`
 * Returns undefined when the line carries no percentage.
 */
export function extractYtDlpProgress(message: string): number | undefined {
  // The template line we configure starts with a literal `download ` marker
  const templateMatch = message.match(/^download\s+(\d+(?:\.\d+)?)%/);
  if (templateMatch?.[1] !== undefined) {
    return Math.min(100, Math.max(0, parseFloat(templateMatch[1])));
  }

  // Fallback for the default progress bar (and older yt-dlp versions that
  // predate --progress-template). Capture the sign too, so a stray negative
  // value clamps to 0 below.
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
