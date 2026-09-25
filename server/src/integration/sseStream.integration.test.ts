import http from 'node:http';
import type { CancelJobResponse, QueueListResponse, QueuePauseResponse } from '@videodeck/shared/api';
import type { DeepServerTestEnv } from '@videodeck/test-infra/deepServerTestEnv';
import { createDeepServerTestEnv, folderConfig } from '@videodeck/test-infra/deepServerTestEnv';
import { downloadQueue } from '../services/downloadQueue';
import { at } from '../test-utils';
import { activeSseStreamCount } from '../utils/sseRegistry';

/**
 * SSE lifecycle over a REAL socket. The Chrome extension closes the tab while
 * a download streams, and the aborted request must release everything the
 * stream holds: the queue listeners, the 15 s heartbeat interval and its slot
 * in the open-stream gauge. A supertest run cannot show that, because the
 * cleanup hangs off the connection dying, not off the request being consumed.
 *
 * The queue stays paused for the whole test, so the stream watches a job that
 * cannot start, finish or fail on its own: every assertion then depends on the
 * abort alone, never on how quickly the runner gets a download job going.
 */

const FOLDER = 'sse-abort';

describe('download-video SSE stream cleanup on client disconnect', () => {
  let env: DeepServerTestEnv;

  beforeAll(async () => {
    env = await createDeepServerTestEnv({ listen: true });
  });

  afterAll(async () => {
    await env.dispose();
  });

  /** GET /metrics until it reports the given number of open streams */
  async function waitForOpenStreams(expected: number): Promise<void> {
    const deadline = Date.now() + 8000;
    let body = '';
    while (Date.now() < deadline) {
      body = (await env.agent.get('/metrics').expect(200)).text;
      if (body.includes(`sse_streams_open ${expected}`)) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`sse_streams_open never reached ${expected}; last body:\n${body}`);
  }

  it('drops the queue listeners, the heartbeat and the open-stream gauge when the client aborts', async () => {
    const folderPath = await env.seedFolder(FOLDER, {
      'config.json': folderConfig('https://www.youtube.com/@sseabort'),
    });
    env.setFolders(FOLDER);

    // A queued job is all this test needs, and a paused queue keeps it queued
    const paused = await env.agent.post('/api/folder/queue/pause?paused=1').expect(200);
    expect((paused.body as QueuePauseResponse).paused).toBe(true);

    // Only setInterval/clearInterval are faked: the socket I/O and the test's
    // own timeouts stay real, while jest counts the heartbeat timer for us.
    jest.useFakeTimers({
      doNotFake: [
        'setTimeout',
        'clearTimeout',
        'setImmediate',
        'clearImmediate',
        'Date',
        'performance',
        'nextTick',
        'queueMicrotask',
        'hrtime',
        'requestAnimationFrame',
        'cancelAnimationFrame',
        'requestIdleCallback',
        'cancelIdleCallback',
      ],
    });
    try {
      const idleTimers = jest.getTimerCount();
      const idleJobListeners = downloadQueue.listenerCount('job');
      const idleProgressListeners = downloadQueue.listenerCount('progress');

      const request = http.request(`${String(env.baseUrl)}/api/folder/download-video`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const response = new Promise<http.IncomingMessage>((resolve) => request.once('response', resolve));
      request.end(JSON.stringify({ folderPath, videoUrl: 'https://www.youtube.com/watch?v=ssetest0001' }));
      const stream = await response;

      const firstChunk = await new Promise<string>((resolve) =>
        stream.once('data', (chunk: Buffer) => resolve(String(chunk))),
      );
      expect(firstChunk).toContain('downloadStart');

      // The app's own state, not a sleep: the stream is watching a job that is
      // still queued, so nothing can have settled it behind our back.
      const queue = await env.agent.get(`/api/folder/queue?folderPath=${encodeURIComponent(folderPath)}`).expect(200);
      const jobs = (queue.body as QueueListResponse).jobs;
      expect(jobs.map((job) => job.status)).toEqual(['queued']);

      // While the stream is open it holds its queue listeners, its heartbeat
      // and its place in the gauge
      expect(downloadQueue.listenerCount('job')).toBe(idleJobListeners + 1);
      expect(downloadQueue.listenerCount('progress')).toBe(idleProgressListeners + 1);
      expect(activeSseStreamCount()).toBe(1);
      await waitForOpenStreams(1);
      // The heartbeat is the only interval the stream adds
      expect(jest.getTimerCount()).toBe(idleTimers + 1);

      // The tab closes: tear the socket down without reading the stream out
      stream.destroy();
      request.destroy();

      await waitForOpenStreams(0);
      expect(downloadQueue.listenerCount('job')).toBe(idleJobListeners);
      expect(downloadQueue.listenerCount('progress')).toBe(idleProgressListeners);
      expect(activeSseStreamCount()).toBe(0);
      expect(jest.getTimerCount()).toBe(idleTimers);

      // The stream is gone but the job is not: cancelling it keeps the queue
      // clean for whatever runs next in this process.
      const job = at(jobs, 0);
      const cancelled = await env.agent.delete(`/api/folder/queue/${job.id}`).expect(200);
      expect((cancelled.body as CancelJobResponse).job?.status).toBe('cancelled');
    } finally {
      jest.useRealTimers();
      await env.agent.post('/api/folder/queue/resume?paused=0').expect(200);
    }
  }, 30_000);
});
