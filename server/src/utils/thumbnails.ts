/**
 * Which file is the thumbnail of a video: one rule for the search index and
 * the folder console. The console used to count any image named after the
 * stem while the index took `.webp` and `.jpg` only, so a video the index
 * skipped for "missing thumbnail" showed no gap and offered no repair.
 */

/** Extensions of a plain sidecar (`<stem>.webp`), most preferred first, matched without case */
const PLAIN_EXTENSIONS = ['webp', 'jpg', 'jpeg', 'png'];

/**
 * What follows `<stem>.` in a numbered variant, one per size as
 * `--write-all-thumbnails` writes them: `<level>.<ext>` from current yt-dlp,
 * `<token>_<level>.<ext>` (`mp4_4.webp`) from older releases. The level grows
 * with the image size.
 */
const VARIANT = /^(?:[^.]*_)?(\d+)\.(?:webp|jpe?g|png)$/i;

/**
 * The thumbnail of the video with this stem among a folder's file names, or
 * undefined when it has none. A plain sidecar wins, `.webp` over `.jpg`,
 * `.jpeg` and `.png`; without one, the highest numbered variant does. That
 * second rule is what keeps a channel downloaded with `--write-all-thumbnails`
 * in thumbnails: its only images are variants.
 */
export function findThumbnailFile(stem: string, files: Iterable<string>): string | undefined {
  const prefix = `${stem}.`;
  let plain: { file: string; rank: number } | undefined;
  let variant: { file: string; level: number } | undefined;
  for (const file of files) {
    if (!file.startsWith(prefix)) {
      continue;
    }
    const rest = file.slice(prefix.length);
    const rank = PLAIN_EXTENSIONS.indexOf(rest.toLowerCase());
    if (rank !== -1) {
      plain = plain === undefined || rank < plain.rank ? { file, rank } : plain;
      continue;
    }
    const level = Number(VARIANT.exec(rest)?.[1] ?? Number.NaN);
    if (!Number.isNaN(level) && (variant === undefined || level > variant.level)) {
      variant = { file, level };
    }
  }
  return plain?.file ?? variant?.file;
}
