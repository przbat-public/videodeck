import http from 'node:http';
import type { QueueJob } from '@videodeck/shared/api';
import type { DeepServerTestEnv } from '@videodeck/test-infra/deepServerTestEnv';
import { createDeepServerTestEnv, folderConfig } from '@videodeck/test-infra/deepServerTestEnv';
import { downloadQueue } from '../services/downloadQueue';
import { activeSseStreamCount } from '../utils/sseRegistry';

/**
 * SSE lifecycle over a REAL socket. The Chrome extension closes the tab while
 * a download streams, and the aborted request must release everything the
 * stream holds: the queue listeners, the 15 s heartbeat interval and its slot
 * in the open-stream gauge. A supertest run cannot show that, because the
 * cleanup hangs off the connection dying, not off the request being consumed.
 */

/** Long enough that the job outlives every assertion made after the abort */
const PROGRESS_DELAY_MS = '1000';

describe('download-video SSE stream cleanup on client disconnect', () => {
  let env: DeepServerTestEnv;

  beforeAll(async () => {
    env = await createDeepServerTestEnv({ listen: true });
  });

  afterAll(async () => {
    await env.dispose();
  });

  /** GET /metrics until it reports the given number of open streams */
  async function waitForOpenStreams(expected: number, timeoutMs = 1200): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let body = '';
    while (Date.now() < deadline) {
      body = (await env.agent.get('/metrics').expect(200)).text;
      if (body.includes(`sse_streams_open ${expected}`)) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`sse_streams_open never reached ${expected} within ${timeoutMs} ms; last body:\n${body}`);
  }

  /** Wait until the job the stream was watching settles, so no download runs on */
  async function waitForJobToSettle(folderPath: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const response = await env.agent.get(`/api/folder/queue?folderPath=${encodeURIComponent(folderPath)}`);
      const jobs = (response.body as { jobs: QueueJob[] }).jobs;
      if (jobs.length > 0 && jobs.every((job) => ['done', 'error', 'cancelled'].includes(job.status))) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('the download job did not settle');
  }

  it('drops the queue listeners, the heartbeat and the open-stream gauge when the client aborts', async () => {
    const folderPath = await env.seedFolder('sse-abort', {
      'config.json': folderConfig('https://www.youtube.com/@sseabort'),
    });
    env.setFolders('sse-abort');
    process.env.FAKE_YTDLP_PROGRESS_DELAY_MS = PROGRESS_DELAY_MS;

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

      // While the stream is open it holds its queue listeners, its heartbeat
      // timer and its place in the gauge
      const openTimers = jest.getTimerCount();
      expect(downloadQueue.listenerCount('job')).toBe(idleJobListeners + 1);
      expect(downloadQueue.listenerCount('progress')).toBe(idleProgressListeners + 1);
      expect(activeSseStreamCount()).toBe(1);
      await waitForOpenStreams(1);
      expect(openTimers).toBeGreaterThan(idleTimers);

      // The tab closes: tear the socket down without reading the stream out.
      // The download keeps running server-side, so every assertion below has
      // to hold while the job is still in flight.
      stream.destroy();
      request.destroy();

      await waitForOpenStreams(0);
      expect(downloadQueue.listenerCount('job')).toBe(idleJobListeners);
      expect(downloadQueue.listenerCount('progress')).toBe(idleProgressListeners);
      expect(activeSseStreamCount()).toBe(0);
      // Exactly the heartbeat went away; the job's own watchdog timer is
      // still armed until it settles.
      expect(jest.getTimerCount()).toBe(openTimers - 1);

      await waitForJobToSettle(folderPath);
      expect(jest.getTimerCount()).toBe(idleTimers);
    } finally {
      process.env.FAKE_YTDLP_PROGRESS_DELAY_MS = '600';
      jest.useRealTimers();
    }
  }, 30_000);
});
