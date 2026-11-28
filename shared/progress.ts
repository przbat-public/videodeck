/**
 * yt-dlp progress lines, read by the server's download queue. Unlike api.ts,
 * which holds types only, this module is imported for real. The Chrome
 * extension takes its progress from the queue's SSE events and imports
 * nothing from here.
 */

/** Our `--progress-template` line starts with a literal `download ` marker */
const TEMPLATE_PROGRESS_RE = /^download\s+(\d+(?:\.\d+)?)%/;

/**
 * The default yt-dlp bar. Anchored like the template, so a percentage
 * anywhere else in a line never matches, and a long run of digits costs
 * linear time. The sign is captured, so a stray negative value clamps to 0.
 */
const BAR_PROGRESS_RE = /^\[download\]\s+(-?\d+(?:\.\d+)?)%\s+of\s+/;

/**
 * Extract the download progress percentage from a yt-dlp output line.
 * Understands two formats:
 *  1. our `--progress-template` line: `download  45.2% (123MiB @ 1MiB/s, ETA 00:45)`
 *  2. the default yt-dlp bar: `[download]  45.2% of 123.45MiB at 1.23MiB/s ETA 00:45`
 * Returns undefined for every other line, so a file name or an error that
 * quotes a percentage never moves the bar. A job that finishes reads 100
 * from the queue itself.
 */
export function extractYtDlpProgress(message: string): number | undefined {
  const match = TEMPLATE_PROGRESS_RE.exec(message) ?? BAR_PROGRESS_RE.exec(message);
  if (match?.[1] === undefined) {
    return undefined;
  }
  return Math.min(100, Math.max(0, parseFloat(match[1])));
}

/**
 * True only for the two progress formats above. The queue keeps these lines
 * out of the job's log, and extractYtDlpProgress reads a percentage from
 * these lines and no others, so a line that stays visible, such as an error
 * that happens to mention a percentage, never moves the bar.
 */
export function isYtDlpProgressLine(message: string): boolean {
  return TEMPLATE_PROGRESS_RE.test(message) || BAR_PROGRESS_RE.test(message);
}
