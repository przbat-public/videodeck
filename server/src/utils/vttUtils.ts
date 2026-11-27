import { siblingVideoPart } from './thumbnails';

/**
 * WebVTT helpers. yt-dlp writes YouTube's automatic captions with explicit
 * cue settings (`align:start position:0%`), which pins every cue to the
 * left edge of the player. Stripping those settings restores the browser
 * default: cues centered at the bottom.
 */

/** A cue timing line: `00:00:03.360 --> 00:00:05.200` + optional settings */
const CUE_TIMING_RE = /^((?:\d{1,2}:)?\d{2}:\d{2}\.\d{3})\s+-->\s+((?:\d{1,2}:)?\d{2}:\d{2}\.\d{3})(?:\s+(.+))?\s*$/;

/**
 * Remove the cue settings (position/align/line/vertical/size) from every
 * cue timing line. Timing lines are normalized to bare timestamps; every
 * other line (headers, tags, text) is untouched. Text lines containing
 * `-->` are not timing lines and stay as they are.
 */
export function stripVttCueSettings(content: string): string {
  // Keep the file's own line endings (CRLF survives round-trips)
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  return content
    .split(/\r\n|\r|\n/)
    .map((line) => {
      const match = CUE_TIMING_RE.exec(line);
      if (!match) {
        return line;
      }
      const start = match[1];
      const end = match[2];
      if (start === undefined || end === undefined) {
        return line;
      }
      return `${start} --> ${end}`;
    })
    .join(eol);
}

const LANG_SUFFIX_RE = /\.([A-Za-z]{2,3}(?:-[A-Za-z]{2})?)\.vtt$/;

/**
 * The language code of a yt-dlp subtitle file name
 * (`…_Title.en.vtt` → `en`, `…_Title.pl.vtt` → `pl`), or undefined when the
 * file name carries no language (plain `….vtt`).
 */
export function vttLanguage(fileName: string): string | undefined {
  const match = LANG_SUFFIX_RE.exec(fileName);
  return match?.[1];
}

/** What follows `<stem>.` in a subtitle of that stem: `vtt` alone, or a language with no dot and `.vtt` */
const OWN_SUBTITLE_RE = /^(?:([^.]+)\.)?vtt$/;

/**
 * The subtitle files of the video with this stem among a folder's file names,
 * in listing order: `<stem>.vtt` and `<stem>.<lang>.vtt`, one rule for the
 * search index, the details route and the folder console. No yt-dlp language
 * code holds a dot, while an older `<upload_date>_<title>` name keeps a
 * title's, so "Part 1.5" is the video `<stem>.5` beside "Part 1" and its
 * captions (`<stem>.5.en.vtt`) start with the other stem. A name whose
 * language part makes a video of its own in the listing (`<stem>.5.vtt` beside
 * `<stem>.5.info.json` or `<stem>.5.mp4`) is that video's plain subtitle.
 */
export function findSubtitleFiles(stem: string, files: Iterable<string>): string[] {
  const prefix = `${stem}.`;
  const candidates: Array<{ file: string; lang: string | undefined }> = [];
  const siblings = new Set<string>();
  for (const file of files) {
    if (!file.startsWith(prefix)) {
      continue;
    }
    const rest = file.slice(prefix.length);
    const sibling = siblingVideoPart(rest);
    if (sibling !== undefined) {
      siblings.add(sibling);
    }
    const subtitle = OWN_SUBTITLE_RE.exec(rest);
    if (subtitle !== null) {
      candidates.push({ file, lang: subtitle[1] });
    }
  }
  return candidates.filter(({ lang }) => lang === undefined || !siblings.has(lang)).map(({ file }) => file);
}
