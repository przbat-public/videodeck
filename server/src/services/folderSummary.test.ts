import type { ChannelVideo } from '@videodeck/shared/api';
import { summarizeFolder } from './folderSummary';

const NOW = Date.parse('2026-09-19T12:00:00.000Z');

const video = (id: string): ChannelVideo => ({
  id,
  title: `Video ${id}`,
  url: `https://www.youtube.com/watch?v=${id}`,
});

describe('summarizeFolder', () => {
  it('counts downloaded, missing and stale videos', () => {
    const summary = summarizeFolder(
      [video('v1'), video('v2'), video('v3')],
      {
        downloadStatuses: { v1: true, v2: true },
        lastUpdatedDates: {
          v1: '2026-09-01T00:00:00.000Z', // 18 days ago
          v2: '2026-01-01T00:00:00.000Z', // stale
        },
      },
      NOW,
    );

    expect(summary).toEqual({
      videos: 3,
      downloaded: 2,
      notDownloaded: 1,
      stale: 1,
      newestUpdate: '2026-09-01T00:00:00.000Z',
    });
  });

  it('treats a download without a usable update date as stale', () => {
    const summary = summarizeFolder(
      [video('v1'), video('v2')],
      {
        downloadStatuses: { v1: true, v2: true },
        lastUpdatedDates: { v2: 'not-a-date' },
      },
      NOW,
    );

    expect(summary.stale).toBe(2);
    expect(summary.newestUpdate).toBeUndefined();
  });

  it('reports zeroes for a folder without list.json', () => {
    expect(summarizeFolder(null, { downloadStatuses: {}, lastUpdatedDates: {} }, NOW)).toEqual({
      videos: 0,
      downloaded: 0,
      notDownloaded: 0,
      stale: 0,
    });
  });

  it('ignores index entries the playlist no longer contains', () => {
    const summary = summarizeFolder(
      [video('v1')],
      {
        downloadStatuses: { v1: true, gone: true },
        lastUpdatedDates: { v1: '2026-09-10T00:00:00.000Z', gone: '2020-01-01T00:00:00.000Z' },
      },
      NOW,
    );

    // `gone` sits in the folder index but not in the playlist: it must not be
    // counted, and its old date must not leak into the newest update.
    expect(summary).toEqual({
      videos: 1,
      downloaded: 1,
      notDownloaded: 0,
      stale: 0,
      newestUpdate: '2026-09-10T00:00:00.000Z',
    });
  });
});
