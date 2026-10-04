import type { DownloadState } from '@videodeck/shared/api';
import { describe, expect, it } from 'vitest';
import i18n from '../i18n';
import {
  formatBytes,
  hasArchiveDrift,
  isOnDisk,
  matchesVideoFilter,
  missingLabel,
  missingSummary,
  needsCompletion,
  skipReasonText,
  VIDEO_STATE_FILTERS,
} from './videoState';

/** A video on disk, complete unless the test says otherwise */
const state = (overrides: Partial<DownloadState> = {}): DownloadState => ({
  files: {
    video: true,
    thumbnail: true,
    description: true,
    subLangs: ['en'],
    comments: true,
    videoBytes: 1048576,
    infoBytes: 2048,
  },
  archive: { onDisk: true, inArchive: true, drift: false },
  missing: [],
  ...overrides,
});

describe('missingLabel', () => {
  it('names the sidecars the server reports by their file kind', () => {
    expect(missingLabel('thumbnail', i18n.t)).toBe(i18n.t('videoState.missing.thumbnail'));
    expect(missingLabel('description', i18n.t)).toBe(i18n.t('videoState.missing.description'));
    expect(missingLabel('comments', i18n.t)).toBe(i18n.t('videoState.missing.comments'));
  });

  it('reads anything else as a subtitle language', () => {
    // The server sends a plain language code for a subtitle that is not there
    expect(missingLabel('pl', i18n.t)).toBe(i18n.t('videoState.missing.subtitle', { lang: 'pl' }));
  });
});

describe('missingSummary', () => {
  it('joins the translated names into one warning line', () => {
    const items = `${i18n.t('videoState.missing.thumbnail')}, ${i18n.t('videoState.missing.subtitle', { lang: 'pl' })}`;

    expect(missingSummary(['thumbnail', 'pl'], i18n.t)).toBe(i18n.t('videoState.badge.missing', { items }));
  });
});

describe('skipReasonText', () => {
  it('translates the reasons the server sends as machine strings', () => {
    expect(skipReasonText('already downloaded', i18n.t)).toBe(i18n.t('skipReason.alreadyDownloaded'));
    expect(skipReasonText('not downloaded', i18n.t)).toBe(i18n.t('skipReason.notDownloaded'));
  });

  it('keeps a reason it has no key for', () => {
    // A validation message the server wrote itself is already readable
    expect(skipReasonText('videoId is not a valid YouTube video id', i18n.t)).toBe(
      'videoId is not a valid YouTube video id',
    );
  });
});

describe('needsCompletion', () => {
  it('is true only for a video on disk that lacks something', () => {
    expect(needsCompletion(state({ missing: ['pl'] }))).toBe(true);
    expect(needsCompletion(state({ missing: [] }))).toBe(false);
    // Not downloaded: `files: null` already says it, the list is not a gap
    expect(needsCompletion(state({ files: null, missing: [] }))).toBe(false);
    expect(needsCompletion(undefined)).toBe(false);
  });
});

describe('isOnDisk', () => {
  it('follows the files of the state', () => {
    expect(isOnDisk(state())).toBe(true);
    expect(isOnDisk(state({ files: null }))).toBe(false);
    expect(isOnDisk(undefined)).toBe(false);
  });
});

describe('hasArchiveDrift', () => {
  it('is true when either side of the archive disagrees with the disk', () => {
    expect(hasArchiveDrift({ missingFromArchive: [], missingFromDisk: [] })).toBe(false);
    expect(hasArchiveDrift({ missingFromArchive: ['a'], missingFromDisk: [] })).toBe(true);
    expect(hasArchiveDrift({ missingFromArchive: [], missingFromDisk: ['b'] })).toBe(true);
  });
});

describe('formatBytes', () => {
  it('formats a size in the reader language', () => {
    expect(formatBytes(0, 'en')).toMatch(/^0\s?B$/);
    expect(formatBytes(512, 'en')).toMatch(/^512\s?B$/);
    // A gigabyte is the top of the ladder, so nothing lands on the fallback
    expect(formatBytes(3 * 1024 ** 3, 'en')).toMatch(/^3\s?GB$/);
    expect(formatBytes(1536, 'en')).toMatch(/1[.,]5\s?kB/);
    expect(formatBytes(5 * 1024 * 1024, 'en')).toMatch(/^5\s?MB$/);
  });

  it('never renders a negative or unusable number as a size', () => {
    expect(formatBytes(-1, 'en')).toMatch(/^0\s?B$/);
    // Infinity is finite enough for the comparison but not a size, and the
    // guard is what keeps "Infinity B" out of the panel.
    expect(formatBytes(Number.POSITIVE_INFINITY, 'en')).toMatch(/^0\s?B$/);
    expect(formatBytes(Number.NaN, 'en')).toMatch(/^0\s?B$/);
  });
});

describe('matchesVideoFilter', () => {
  it('keeps every row under the "all" chip', () => {
    expect(matchesVideoFilter(state(), 'all')).toBe(true);
    expect(matchesVideoFilter(state({ files: null, missing: [] }), 'all')).toBe(true);
    expect(matchesVideoFilter(undefined, 'all')).toBe(true);
  });

  it('selects the videos that are on disk with something missing', () => {
    expect(matchesVideoFilter(state({ missing: ['pl'] }), 'incomplete')).toBe(true);
    expect(matchesVideoFilter(state({ missing: [] }), 'incomplete')).toBe(false);
    // A video that was never downloaded is not "incomplete", it is absent
    expect(matchesVideoFilter(state({ files: null }), 'incomplete')).toBe(false);
  });

  it('selects the videos the folder never downloaded', () => {
    expect(matchesVideoFilter(state({ files: null }), 'not-downloaded')).toBe(true);
    expect(matchesVideoFilter(state(), 'not-downloaded')).toBe(false);
    expect(matchesVideoFilter(undefined, 'not-downloaded')).toBe(false);
  });

  it('never counts a catalog row as an orphan', () => {
    // The orphan group renders those rows; they are not part of list.json
    expect(matchesVideoFilter(state(), 'orphan')).toBe(false);
  });
});

describe('VIDEO_STATE_FILTERS', () => {
  it('mirrors the filters the state endpoint accepts', () => {
    expect(VIDEO_STATE_FILTERS.map((option) => option.value)).toEqual([
      'all',
      'incomplete',
      'orphan',
      'not-downloaded',
    ]);
  });

  it('has a catalog entry behind every label', () => {
    for (const option of VIDEO_STATE_FILTERS) {
      expect(i18n.t(option.labelKey, { count: 3 })).not.toBe(option.labelKey);
    }
  });
});
