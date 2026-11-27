import http from 'node:http';
import type { DeepServerTestEnv } from '@videodeck/test-infra/deepServerTestEnv';
import { createDeepServerTestEnv, videoFiles } from '@videodeck/test-infra/deepServerTestEnv';

/**
 * A search its client walked away from, over a REAL socket. Typing a new phrase
 * aborts the browser's fetch and nginx passes the disconnect on, so the server
 * has to stop waiting on Elasticsearch as well: a cluster cancels a search
 * once its HTTP connection closes, and keeps scoring and highlighting a page
 * nobody reads while it stays open. A supertest run cannot drop a connection
 * under a request, so this suite listens on a port of its own.
 */

/** How long the app may keep its Elasticsearch request open once the client left */
const CANCEL_BUDGET_MS = 2_000;

describe('search cancellation when the client disconnects', () => {
  /** How long the seeded folder's reindex may take before the suite gives up */
  const REINDEX_BUDGET_MS = 8_000;
  let env: DeepServerTestEnv;

  beforeAll(async () => {
    env = await createDeepServerTestEnv({ listen: true });
    await env.seedFolder('search-cancel', videoFiles('cancel00001', 'Film do porzucenia'));
    env.setFolders('search-cancel');
    await env.agent.post('/api/videos/refreshCache').expect(202);
    await vi.waitFor(
      async () => {
        const status = await env.agent.get('/api/videos/refreshCache/status').expect(200);
        expect((status.body as { running: boolean }).running, 'the reindex of the seeded folder finished').toBe(false);
      },
      { timeout: REINDEX_BUDGET_MS, interval: 50 },
    );
  });

  afterAll(async () => {
    await env.dispose();
  });

  it('cancels the Elasticsearch search when the client goes away and keeps the next search working', async () => {
    const hold = env.fakeEs.holdRequestsMatching('/_msearch');
    try {
      const request = http.get(`${String(env.baseUrl)}/api/videos/search?q=film`);
      request.on('error', () => {
        /* the destroy below is the point of the test */
      });
      await hold.reached;

      // The client moves on while Elasticsearch is still working on the page
      request.destroy();

      const outcome = await Promise.race([
        hold.abandoned.then(() => 'cancelled'),
        new Promise((resolve) => setTimeout(() => resolve('still open'), CANCEL_BUDGET_MS)),
      ]);
      expect(outcome).toBe('cancelled');
    } finally {
      hold.release();
    }

    // A search nobody waits for is no outage: the next one is served, not
    // refused by the fail-fast window an unreachable cluster arms
    const next = await env.agent.get('/api/videos/search?q=film').expect(200);
    expect(next.body.videos.map((video: { title: string }) => video.title)).toEqual(['Film do porzucenia']);
  });
});
