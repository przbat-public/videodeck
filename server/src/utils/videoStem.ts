/**
 * What a video file stem is allowed to be.
 *
 * yt-dlp receives a stem inside its `-o` output template, which is a path
 * template: `../../x.%(ext)s` writes outside the channel folder. The stem
 * reaches that argument from three places (the folder index, the queue state
 * file, and whatever caller comes next), so the shape is defined once here and
 * checked at every boundary, with the spawn as the last one.
 */

/**
 * Longest stem accepted: yt-dlp's own output stays below it. Downloads are
 * named `<upload_date>_<title>_<id>` in ASCII (--restrict-filenames), which
 * leaves 179 characters for the sanitized title.
 */
export const MAX_VIDEO_STEM_LENGTH = 200;

/** A stem's upload date, or `NA`, which yt-dlp writes for a video without one */
const UPLOAD_DATE_PREFIX_RE = /^(\d{8}|NA)_/;

/**
 * A readable title from a file stem, for a video whose metadata has none.
 * Older downloads are named `<upload_date>_<title>`, newer ones end in the
 * video id as well. The id goes only when it is this video's whole suffix: an
 * id may hold `_` and `-`, and an older title may end in a word that merely
 * looks like one.
 */
export function titleFromStem(stem: string, videoId: string | undefined): string {
  const idSuffix = videoId ? `_${videoId}` : undefined;
  const withoutId = idSuffix && stem.endsWith(idSuffix) ? stem.slice(0, -idSuffix.length) : stem;
  return withoutId.replace(UPLOAD_DATE_PREFIX_RE, '').replaceAll('_', ' ');
}

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

/**
 * Whether a stem may go into yt-dlp's `-o` template: a safe stem without `$`.
 * yt-dlp runs the template through os.path.expandvars before it fills in the
 * fields, and `$$` is no escape on POSIX, so `$API_TOKEN.%(ext)s` would name
 * the file after the token. The folder index and the queue state keep
 * isSafeVideoStem: a hand-named file with a `$` stays indexed, searchable
 * and playable, and only a yt-dlp run on it is refused.
 */
export function isTemplateSafeStem(value: string): boolean {
  return isSafeVideoStem(value) && !value.includes('$');
}
