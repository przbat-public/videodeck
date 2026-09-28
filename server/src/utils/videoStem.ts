/**
 * What a video file stem is allowed to be.
 *
 * yt-dlp receives a stem inside its `-o` output template, which is a path
 * template: `../../x.%(ext)s` writes outside the channel folder. The stem
 * reaches that argument from three places (the folder index, the queue state
 * file, and whatever caller comes next), so the shape is defined once here and
 * checked at every boundary, with the spawn as the last one.
 */

/** Longest stem accepted: yt-dlp's own output stays far below it */
export const MAX_VIDEO_STEM_LENGTH = 200;

/**
 * Whether a value is usable as a video file stem: one path segment, non-empty,
 * without `/`, `\` or NUL, not a `.`/`..` reference, and bounded. A stem that
 * fails this cannot be repaired into the intended file, so callers drop it
 * rather than guess.
 */
export function isSafeVideoStem(value: string): boolean {
  if (value.length === 0 || value.length > MAX_VIDEO_STEM_LENGTH) {
    return false;
  }
  if (value === '.' || value === '..') {
    return false;
  }
  return !value.includes('/') && !value.includes('\\') && !value.includes('\0');
}
