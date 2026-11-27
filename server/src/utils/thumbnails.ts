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
 * A name that makes `<stem>.<level>` a video of its own: its metadata or its
 * media. Restricted names keep a title's dot, so "Part 1.5" is the video
 * `<stem>.5` beside "Part 1", and its plain thumbnail reads like a numbered
 * size of the other one. Both share the `<stem>.` prefix, so one pass sees them.
 */
const SIBLING_VIDEO = /^(\d+)\.(?:info\.json|mp4|mkv)$/i;

/** What the names under `<stem>.` hold: the plain sidecar, the numbered sizes, the sibling videos */
interface StemImages {
  plain: { file: string; rank: number } | undefined;
  variants: Array<{ file: string; level: number; bareLevel: string | undefined }>;
  siblingLevels: Set<string>;
}

/** Record one name under `<stem>.`, where `rest` is what follows that prefix */
function addName(found: StemImages, file: string, rest: string): void {
  const rank = PLAIN_EXTENSIONS.indexOf(rest.toLowerCase());
  if (rank !== -1) {
    found.plain = found.plain === undefined || rank < found.plain.rank ? { file, rank } : found.plain;
    return;
  }
  const sibling = SIBLING_VIDEO.exec(rest)?.[1];
  if (sibling !== undefined) {
    found.siblingLevels.add(sibling);
    return;
  }
  const variant = VARIANT.exec(rest)?.[1];
  if (variant !== undefined) {
    // Only a bare `<level>.<ext>` can be a sibling's plain thumbnail
    found.variants.push({ file, level: Number(variant), bareLevel: rest.includes('_') ? undefined : variant });
  }
}

function scanStem(stem: string, files: Iterable<string>): StemImages {
  const prefix = `${stem}.`;
  const found: StemImages = { plain: undefined, variants: [], siblingLevels: new Set() };
  for (const file of files) {
    if (file.startsWith(prefix)) {
      addName(found, file, file.slice(prefix.length));
    }
  }
  return found;
}

/**
 * The thumbnail of the video with this stem among a folder's file names, or
 * undefined when it has none. A plain sidecar wins, `.webp` over `.jpg`,
 * `.jpeg` and `.png`; without one, the highest numbered variant does. That
 * second rule is what keeps a channel downloaded with `--write-all-thumbnails`
 * in thumbnails: its only images are variants.
 */
export function findThumbnailFile(stem: string, files: Iterable<string>): string | undefined {
  const { plain, variants, siblingLevels } = scanStem(stem, files);
  if (plain !== undefined) {
    return plain.file;
  }
  let best: { file: string; level: number } | undefined;
  for (const variant of variants) {
    const isSibling = variant.bareLevel !== undefined && siblingLevels.has(variant.bareLevel);
    if (!isSibling && (best === undefined || variant.level > best.level)) {
      best = variant;
    }
  }
  return best?.file;
}
