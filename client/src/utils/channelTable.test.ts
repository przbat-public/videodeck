import type { QueueJob, StatusResponse } from '@videodeck/shared/api';
import { describe, expect, it } from 'vitest';
import {
  buildChannelRows,
  filterChannels,
  foldersWithFinishedJobs,
  sortChannels,
  summarizeChannels,
} from './channelTable';

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
  elasticsearch: 'ok',
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
  it('carries the channel name the search page filters by', () => {
    const built = buildChannelRows(status, summaries.summaries, [], {
      '/videos/kanal-b': 'Kanał B',
    });

    expect(built[0]?.channelName).toBe('Kanał B');
    // A folder with no indexed videos has no channel name: the console hides
    // the search link for it instead of pointing at a filter that matches
    // nothing
    expect(built[1]?.channelName).toBeUndefined();
  });

  it('reports no index state while Elasticsearch could not be read', () => {
    const built = buildChannelRows({ ...status, elasticsearch: 'down', indexedFolders: [] }, summaries.summaries, []);

    // A chip per channel would say "reindex everything"; the banner above the
    // table says the cluster is down
    expect(built.map((row) => row.indexed)).toEqual([null, null, null]);
    expect(built.flatMap((row) => row.attention)).not.toContain('noIndex');
  });

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

  it('leaves the category out when the config has none', () => {
    const built = buildChannelRows(status, summaries.summaries, []);

    expect('category' in (built[2] ?? {})).toBe(false);
    expect(built[2]?.category).toBeUndefined();
  });

  it('keeps the first error when several jobs failed', () => {
    const built = buildChannelRows(status, {}, [
      job({ id: 'job-1', status: 'error', error: 'first' }),
      job({ id: 'job-2', status: 'error', error: 'second' }),
    ]);

    expect(built[1]?.queue).toMatchObject({ failed: 2, firstError: 'first' });
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

  it('returns every row for an empty query and the "all" chip', () => {
    const built = rows();

    expect(filterChannels(built, { query: '   ', filter: 'all' })).toHaveLength(3);
  });

  it('breaks ties on the name so the order never depends on the input order', () => {
    const built = buildChannelRows(status, {}, []);

    // No summaries at all: every channel ties on "missing" and on "updated"
    expect(sortChannels(built, 'missing').map((row) => row.name)).toEqual(['kanal-a', 'kanal-b', 'kanal-c']);
    expect(sortChannels(built, 'updated').map((row) => row.name)).toEqual(['kanal-a', 'kanal-b', 'kanal-c']);
  });

  it('orders two channels with the same update date by name', () => {
    const sameDate = {
      summaries: {
        '/videos/kanal-a': {
          videos: 1,
          downloaded: 1,
          notDownloaded: 0,
          stale: 0,
          newestUpdate: '2026-09-01T00:00:00.000Z',
        },
        '/videos/kanal-b': {
          videos: 1,
          downloaded: 1,
          notDownloaded: 0,
          stale: 0,
          newestUpdate: '2026-09-01T00:00:00.000Z',
        },
      },
    };

    expect(sortChannels(buildChannelRows(status, sameDate.summaries, []), 'updated').map((row) => row.name)).toEqual([
      'kanal-a',
      'kanal-b',
      'kanal-c',
    ]);
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

describe('foldersWithFinishedJobs', () => {
  it('names each folder once whose job left the queue since the previous poll', () => {
    const previous = [
      job({ id: 'a-1', folderPath: '/videos/kanal-a', status: 'running' }),
      job({ id: 'a-2', folderPath: '/videos/kanal-a', status: 'queued' }),
      job({ id: 'b-1', folderPath: '/videos/kanal-b', status: 'queued' }),
      job({ id: 'c-1', folderPath: '/videos/kanal-c', status: 'done' }),
    ];
    const current = [
      job({ id: 'a-1', folderPath: '/videos/kanal-a', status: 'done' }),
      job({ id: 'a-2', folderPath: '/videos/kanal-a', status: 'error' }),
      job({ id: 'b-1', folderPath: '/videos/kanal-b', status: 'running' }),
      // c-1 was cleared from the queue, but it had already finished before
      job({ id: 'd-1', folderPath: '/videos/kanal-d', status: 'done' }),
    ];

    expect(foldersWithFinishedJobs(previous, current)).toEqual(['/videos/kanal-a']);
  });

  it('counts a job that vanished while active as finished', () => {
    // Cancelled and swept between two polls: the folder may still have
    // changed on disk before the cancel landed
    const previous = [job({ id: 'a-1', folderPath: '/videos/kanal-a', status: 'running' })];

    expect(foldersWithFinishedJobs(previous, [])).toEqual(['/videos/kanal-a']);
  });

  it('reports nothing on the first poll and while nothing changes', () => {
    const jobs = [job({ id: 'a-1', status: 'running' })];

    expect(foldersWithFinishedJobs([], jobs)).toEqual([]);
    expect(foldersWithFinishedJobs(jobs, jobs)).toEqual([]);
  });
});
