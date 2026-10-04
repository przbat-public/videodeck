import type { ArchiveDrift, DownloadState } from '@videodeck/shared/api';
import type { TFunction } from 'i18next';

/**
 * The per-video state, read as the console renders it. Everything here is
 * pure, and everything user-visible goes through an i18n key: the server
 * reports sidecars and subtitle languages as machine strings (`thumbnail`,
 * `pl`), so the translation happens here rather than in three components.
 */

/** The filters `GET /api/folder/state` accepts, in the order the chips show them */
export type VideoStateFilter = 'all' | 'incomplete' | 'orphan' | 'not-downloaded';

export interface VideoStateFilterOption {
  value: VideoStateFilter;
  labelKey:
    | 'videoState.filter.all'
    | 'videoState.filter.incomplete'
    | 'videoState.filter.orphan'
    | 'videoState.filter.notDownloaded';
}

export const VIDEO_STATE_FILTERS: readonly VideoStateFilterOption[] = [
  { value: 'all', labelKey: 'videoState.filter.all' },
  { value: 'incomplete', labelKey: 'videoState.filter.incomplete' },
  { value: 'orphan', labelKey: 'videoState.filter.orphan' },
  { value: 'not-downloaded', labelKey: 'videoState.filter.notDownloaded' },
];

/** The sidecars the state names by their file kind; anything else is a language code */
const SIDECAR_LABEL_KEYS = {
  thumbnail: 'videoState.missing.thumbnail',
  description: 'videoState.missing.description',
  comments: 'videoState.missing.comments',
} as const;

/** Name of one missing entry: a sidecar kind or a subtitle language */
export function missingLabel(missing: string, t: TFunction): string {
  const key = SIDECAR_LABEL_KEYS[missing as keyof typeof SIDECAR_LABEL_KEYS];
  if (key !== undefined) {
    return t(key);
  }
  return t('videoState.missing.subtitle', { lang: missing });
}

/** One warning line naming everything a video lacks, for the row badge */
export function missingSummary(missing: readonly string[], t: TFunction): string {
  const items = missing.map((entry) => missingLabel(entry, t)).join(', ');
  return t('videoState.badge.missing', { items });
}

/**
 * The skip reasons the queue endpoint answers with are English machine
 * strings (`already downloaded`), not prose: the client translates them
 * instead of printing the server's wording in a Polish UI.
 *
 * The codes at the end are the ones the queue refuses a video with, either
 * from the catalog or from the folder's own record of permanent failures. They
 * reuse the job-error copy, because the reader has to see one sentence per
 * reason, not two versions of it.
 */
const SKIP_REASON_KEYS = {
  'already downloaded': 'skipReason.alreadyDownloaded',
  'not downloaded': 'skipReason.notDownloaded',
  'members-only': 'errors.job.members-only',
  'premium-only': 'errors.job.premium-only',
  private: 'errors.job.private',
  removed: 'errors.job.removed',
  'geo-restricted': 'errors.job.geo-restricted',
  'age-gate': 'errors.job.age-gate',
} as const;

/** A skip reason in the reader's language, or the server's own wording */
export function skipReasonText(reason: string, t: TFunction): string {
  const key = SKIP_REASON_KEYS[reason as keyof typeof SKIP_REASON_KEYS];
  return key === undefined ? reason : t(key);
}

/**
 * Whether a video on disk is missing something its folder asked for: the rule
 * behind both the warning badge and the "needs completion" filter. A video
 * that is not downloaded has `files: null` and an empty list, so it never
 * counts as incomplete.
 */
export function needsCompletion(state: DownloadState | undefined): boolean {
  return state !== undefined && state.files !== null && state.missing.length > 0;
}

/** Whether a video file is on disk, which is what "downloaded" means */
export function isOnDisk(state: DownloadState | undefined): boolean {
  return state !== undefined && state.files !== null;
}

/**
 * Whether a row of `list.json` survives the chip the console has on. An
 * unknown state (the folder read has not answered yet, or failed) passes
 * every filter but the two that need an answer, so a failed read narrows the
 * list instead of emptying it.
 */
export function matchesVideoFilter(state: DownloadState | undefined, filter: VideoStateFilter): boolean {
  switch (filter) {
    case 'incomplete':
      return needsCompletion(state);
    case 'not-downloaded':
      return state !== undefined && state.files === null;
    case 'orphan':
      // Orphans are not rows of list.json: the group under the list shows them
      return false;
    default:
      return true;
  }
}

/** Whether `archive.txt` and the disk disagree somewhere in this folder */
export function hasArchiveDrift(drift: ArchiveDrift): boolean {
  return drift.missingFromArchive.length > 0 || drift.missingFromDisk.length > 0;
}

/**
 * Unit ladder for `formatBytes`, base 1024. The tuple type spells out its
 * length, so the last entry (the gigabyte, whose limit is infinite) is a value
 * rather than a possible `undefined`.
 */
type ByteUnit = { limit: number; unit: string; divisor: number };
const BYTE_UNITS: readonly [ByteUnit, ByteUnit, ByteUnit, ByteUnit] = [
  { limit: 1024, unit: 'byte', divisor: 1 },
  { limit: 1024 ** 2, unit: 'kilobyte', divisor: 1024 },
  { limit: 1024 ** 3, unit: 'megabyte', divisor: 1024 ** 2 },
  { limit: Number.POSITIVE_INFINITY, unit: 'gigabyte', divisor: 1024 ** 3 },
];

/**
 * A byte count in the reader's language (`1.5 kB`, `1,5 kB`). The unit and the
 * decimal separator come from `Intl`, so the size reads right in both
 * catalogs without a key per unit. A size nobody can show (negative, NaN)
 * falls back to zero: the panel has a number or a dash, never `NaN`.
 */
export function formatBytes(bytes: number, locale: string): string {
  const safe = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  // The ladder is walked rather than searched: the last unit is the starting
  // point, so there is no "found nothing" case to write a fallback branch for.
  let chosen = BYTE_UNITS[3];
  for (const candidate of BYTE_UNITS) {
    if (safe < candidate.limit) {
      chosen = candidate;
      break;
    }
  }
  const value = safe / chosen.divisor;
  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: chosen.unit,
    unitDisplay: 'narrow',
    maximumFractionDigits: value < 10 ? 1 : 0,
  }).format(value);
}
