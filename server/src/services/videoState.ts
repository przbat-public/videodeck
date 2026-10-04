import type { FolderConfig } from '@videodeck/shared/api';
import type { FolderIndexEntry } from './folderIndex';

/**
 * What one video looks like on disk, what the archive says about it and what is
 * still missing. The console used to show a single boolean, which could not
 * tell a complete video from one that lost its subtitles, and it could not see
 * a video that `archive.txt` claims to hold while the disk says otherwise.
 */

/**
 * The files of one video, as the folder index records them. The shape mirrors
 * `VideoFilesStateSchema` in `shared/schemas.ts`, which is the contract the
 * client parses; this local copy keeps the service free of a runtime import.
 */
export interface VideoFilesState {
  video: boolean;
  thumbnail: boolean;
  description: boolean;
  /** Subtitle languages on disk (`en`, `pl`, …) */
  subLangs: string[];
  comments: boolean;
  videoBytes: number;
  infoBytes: number;
}

export interface VideoArchiveState {
  onDisk: boolean;
  inArchive: boolean;
  /** The two disagree: a re-download or a repair is what settles it */
  drift: boolean;
}

export interface VideoDownloadState {
  /** null when nothing of this video is on disk */
  files: VideoFilesState | null;
  archive: VideoArchiveState;
  /**
   * Sidecars this folder wanted and the video does not have: `thumbnail`,
   * `description`, `comments`, or a subtitle language code. Empty for a video
   * that is not downloaded at all, which the `files` field already says.
   */
  missing: string[];
}

/** A video entry as the folder index reports it, plus the archive's opinion */
export interface VideoStateInput {
  entry: FolderIndexEntry | null;
  inArchive: boolean;
}

/** One entry of the video state list: the catalog row and its state */
export interface VideoStateRow {
  id: string;
  title: string;
  state: VideoDownloadState;
  /** On disk, but the channel's list.json no longer contains it */
  orphan: boolean;
}

/**
 * The sidecars a folder asks for, from its config: which subtitle languages to
 * keep, and whether comments and the description are wanted at all. The server
 * defaults mirror `DEFAULT_DOWNLOAD_OPTIONS` so a folder without a config.json
 * is judged the same way it is downloaded.
 */
export interface WantedSidecars {
  subLangs: string[];
  comments: boolean;
  description: boolean;
  thumbnail: boolean;
}

export const DEFAULT_WANTED_SIDECARS: WantedSidecars = {
  subLangs: ['en'],
  comments: true,
  description: true,
  thumbnail: true,
};

export function wantedSidecars(config: FolderConfig | null | undefined): WantedSidecars {
  const subLangs = Array.isArray(config?.subLangs)
    ? config.subLangs.filter((lang): lang is string => typeof lang === 'string' && lang.length > 0)
    : DEFAULT_WANTED_SIDECARS.subLangs;
  return {
    subLangs,
    comments: config?.writeComments !== false,
    description: !(config?.extraArgs ?? []).includes('--no-write-description'),
    thumbnail: !(config?.extraArgs ?? []).includes('--no-write-thumbnail'),
  };
}

/** The static part of a state: what is on disk versus what the archive says */
function baseState(input: VideoStateInput): Omit<VideoDownloadState, 'missing'> {
  const { entry, inArchive } = input;
  return {
    files:
      entry === null
        ? null
        : {
            video: true,
            thumbnail: entry.hasThumbnail,
            description: entry.hasDescription,
            subLangs: entry.subtitleLangs,
            comments: entry.hasComments,
            videoBytes: entry.videoBytes,
            infoBytes: entry.infoBytes,
          },
    archive: {
      onDisk: entry !== null,
      inArchive,
      drift: (entry !== null) !== inArchive,
    },
  };
}

/**
 * The sidecars the folder wanted and the video does not have. A video that is
 * not on disk reports nothing here: `files: null` is the answer, and listing
 * every artifact as missing would flood the UI with rows that only mean "not
 * downloaded".
 */
export function missingSidecars(state: Omit<VideoDownloadState, 'missing'>, wanted: WantedSidecars): string[] {
  const files = state.files;
  if (files === null) {
    return [];
  }
  const missing: string[] = [];
  if (wanted.thumbnail && !files.thumbnail) {
    missing.push('thumbnail');
  }
  if (wanted.description && !files.description) {
    missing.push('description');
  }
  if (wanted.comments && !files.comments) {
    missing.push('comments');
  }
  for (const lang of wanted.subLangs) {
    if (!files.subLangs.includes(lang)) {
      missing.push(lang);
    }
  }
  return missing;
}

/** The state of one video: what it has, what the archive says, what is missing */
export function videoDownloadState(input: VideoStateInput, wanted: WantedSidecars): VideoDownloadState {
  const state = baseState(input);
  return { ...state, missing: missingSidecars(state, wanted) };
}

/**
 * Whether a download job should be enqueued for this video. The app answers
 * this instead of leaving it to yt-dlp's `--download-archive`: the archive is a
 * file another tool writes, and a video whose files were deleted stays in it,
 * so "the archive has it" and "I have it" are different questions.
 */
export function needsDownload(entry: FolderIndexEntry | null): boolean {
  return entry === null;
}

/** Whether a video on disk is missing something its folder asked for */
export function needsRepair(state: VideoDownloadState): boolean {
  return state.files !== null && state.missing.length > 0;
}
