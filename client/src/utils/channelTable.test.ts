import type { QueueJob, StatusResponse } from '@videodeck/shared/api';
import { describe, expect, it } from 'vitest';
import { buildChannelRows, filterChannels, sortChannels, summarizeChannels } from './channelTable';

const status: StatusResponse = {
  videosFolderPath: ['/videos/kanal-b', '/videos/kanal-a', '/videos/kanal-c'],
  folderConfigs: {
    '/videos/kanal-b': { channelUrl: 'https://www.youtube.com/@b', category: 'fpv' },
    '/videos/kanal-a': { channelUrl: 'https://www.youtube.com/@a' },
    '/videos/kanal-c': {},
  },
  downloadDefaults: { maxHeight: 2160, subLangs: ['en'], writeComments: true },
  indexedFolders: ['/videos/kanal-a', '/videos/kanal-b'],
  listExists: { '/videos/kanal-b': true, '/videos/kanal-a': true, '/videos/kanal-c': false },
  status: 'ok',
};

const summaries = {
  summaries: {
    '/videos/kanal-a': {
      videos: 10,
      downloaded: 8,
      notDownloaded: 2,
      stale: 3,
      newestUpdate: '2026-08-01T00:00:00.000Z',
    },
    '/videos/kanal-b': {
      videos: 5,
      downloaded: 5,
      notDownloaded: 0,
      stale: 0,
      newestUpdate: '2026-09-15T00:00:00.000Z',
    },
  },
};

const job = (overrides: Partial<QueueJob>): QueueJob => ({
  id: 'job-1',
  folderPath: '/videos/kanal-a',
  videoId: 'v1',
  videoUrl: 'https://yt/v1',
  type: 'download',
  status: 'running',
  log: [],
  logLineCount: 0,
  createdAt: '2026-09-19T10:00:00.000Z',
  ...overrides,
});

const rows = () =>
  buildChannelRows(status, summaries.summaries, [
    job({}),
    job({ id: 'job-2', status: 'queued' }),
    job({ id: 'job-3', status: 'error', error: 'yt-dlp exited with code 1' }),
  ]);

describe('buildChannelRows', () => {
  it('builds one row per configured folder, keeping the status order', () => {
    const built = rows();

    expect(built.map((row) => row.folderPath)).toEqual(['/videos/kanal-b', '/videos/kanal-a', '/videos/kanal-c']);
    expect(built[0]).toMatchObject({
      name: 'kanal-b',
      category: 'fpv',
      configured: true,
      indexed: true,
      listExists: true,
      summary: summaries.summaries['/videos/kanal-b'],
    });
  });

  it('counts the queue per folder and remembers the first failure', () => {
    const built = buildChannelRows(status, summaries.summaries, [
      job({}),
      job({ id: 'job-2', status: 'queued' }),
      job({ id: 'job-3', status: 'error', error: 'yt-dlp exited with code 1' }),
      job({ id: 'job-4', folderPath: '/videos/kanal-b', status: 'error', error: 'members-only' }),
    ]);

    expect(built[1]?.queue).toEqual({ running: 1, queued: 1, failed: 1, firstError: 'yt-dlp exited with code 1' });
    expect(built[0]?.queue).toEqual({ running: 0, queued: 0, failed: 1, firstError: 'members-only' });
    expect(built[2]?.queue).toEqual({ running: 0, queued: 0, failed: 0, firstError: undefined });
  });

  it('lists why a channel needs attention, worst first', () => {
    const built = rows();

    // kanal-a: stale downloads and a failed job
    expect(built[1]?.attention).toEqual(['failed', 'stale']);
    // kanal-b: nothing wrong
    expect(built[0]?.attention).toEqual([]);
    // kanal-c: no channel URL, no list.json, no index
    expect(built[2]?.attention).toEqual(['noChannelUrl', 'noList', 'noIndex']);
  });

  it('leaves the summary absent while it has not arrived', () => {
    const built = buildChannelRows(status, {}, []);

    expect(built.every((row) => row.summary === undefined)).toBe(true);
  });
});

describe('filterChannels', () => {
  it('matches the text filter against the name, the path and the category', () => {
    const built = rows();

    expect(filterChannels(built, { query: 'kanal-a', filter: 'all' }).map((row) => row.name)).toEqual(['kanal-a']);
    expect(filterChannels(built, { query: 'fpv', filter: 'all' }).map((row) => row.name)).toEqual(['kanal-b']);
    expect(filterChannels(built, { query: 'KANAL', filter: 'all' })).toHaveLength(3);
    expect(filterChannels(built, { query: 'nope', filter: 'all' })).toEqual([]);
  });

  it('filters by attention, queue activity and failures', () => {
    const built = rows();

    expect(filterChannels(built, { query: '', filter: 'attention' }).map((row) => row.name)).toEqual([
      'kanal-a',
      'kanal-c',
    ]);
    expect(filterChannels(built, { query: '', filter: 'queue' }).map((row) => row.name)).toEqual(['kanal-a']);
    expect(filterChannels(built, { query: '', filter: 'failed' }).map((row) => row.name)).toEqual(['kanal-a']);
  });
});

describe('sortChannels', () => {
  it('sorts by name, attention, newest update and missing videos', () => {
    const built = rows();

    expect(sortChannels(built, 'name').map((row) => row.name)).toEqual(['kanal-a', 'kanal-b', 'kanal-c']);
    // attention first: kanal-a and kanal-c have two and three reasons
    expect(sortChannels(built, 'attention').map((row) => row.name)).toEqual(['kanal-c', 'kanal-a', 'kanal-b']);
    // newest update first, channels without any summary last
    expect(sortChannels(built, 'updated').map((row) => row.name)).toEqual(['kanal-b', 'kanal-a', 'kanal-c']);
    // most missing videos first
    expect(sortChannels(built, 'missing').map((row) => row.name)).toEqual(['kanal-a', 'kanal-b', 'kanal-c']);
  });
});

describe('summarizeChannels', () => {
  it('totals the videos, the missing ones and the channels needing attention', () => {
    expect(summarizeChannels(rows())).toEqual({
      channels: 3,
      videos: 15,
      notDownloaded: 2,
      needsAttention: 2,
    });
  });
});
