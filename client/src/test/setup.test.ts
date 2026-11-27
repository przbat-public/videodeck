import { describe, expect, it } from 'vitest';
import { getQueueSummaryState, refreshQueueSummary } from '../utils/queueSummaryStore';
import { installFetchMock, jsonResponse } from './fetchMock';

const fetchMock = installFetchMock();

/** One job still queued, the summary a status page test leaves behind */
const QUEUED_WORK = {
  paused: true,
  counts: { queued: 1, running: 0, done: 0, error: 0, cancelled: 0 },
  folders: { '/videos/channel': { queued: 1, running: 0, failed: 0 } },
  running: [],
};

/**
 * What setup.ts promises every test: the app's module-level stores start
 * empty. The first case leaves queued work in the queue summary store, as a
 * status page test does; the second is the test that runs after it and must
 * not see that work. The order is the point, so `shuffle: false` holds it in
 * the nightly's shuffled run too (seed 9137 puts the second case first, where
 * it proves nothing). Run alone with `-t`, the second case passes, because no
 * test before it filled the store.
 */
describe('shared test setup', { shuffle: false }, () => {
  it('lets a test leave queued work in the queue summary store', async () => {
    fetchMock.mockResolvedValue(jsonResponse(QUEUED_WORK));

    await refreshQueueSummary();

    expect(getQueueSummaryState().summary?.counts.queued).toBe(1);
  });

  it('starts the next test with an empty queue summary store', () => {
    expect(getQueueSummaryState()).toEqual({ summary: null, error: null });
  });
});
