import { existsSync } from 'node:fs';
import type { QueueJob } from '@videodeck/shared/api';
import type { DeepServerTestEnv } from '@videodeck/test-infra/deepServerTestEnv';
import { createDeepServerTestEnv, folderConfig, videoFiles } from '@videodeck/test-infra/deepServerTestEnv';

/**
 * Deep integration: the REAL Express app (routes + services + queue) over
 * HTTP, with only the external world faked — in-process Elasticsearch, a
 * mock OpenAI server and the fake yt-dlp binary writing real files into
 * temp folders. Nothing here mocks server modules.
 */

describe('deep server integration (real app, fake external world)', () => {
  let env: DeepServerTestEnv;

  beforeAll(async () => {
    env = await createDeepServerTestEnv();
  });

  afterAll(async () => {
    await env.dispose();
  });

  async function waitFor(
    poll: () => Promise<unknown>,
    done: (value: unknown) => boolean,
    timeoutMs = 8000,
  ): Promise<unknown> {
    const deadline = Date.now() + timeoutMs;
    let last: unknown;
    while (Date.now() < deadline) {
      last = await poll();
      if (done(last)) {
        return last;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`condition not met within ${timeoutMs} ms; last value: ${JSON.stringify(last)}`);
  }

  const waitForRefreshIdle = () =>
    waitFor(
      async () => (await env.agent.get('/api/videos/refreshCache/status').expect(200)).body,
      (status) => (status as { running: boolean }).running === false,
    );

  const waitForJobStatus = (folderPath: string, videoId: string, status: QueueJob['status']) =>
    waitFor(
      async () => {
        const response = await env.agent
          .get(`/api/folder/queue?folderPath=${encodeURIComponent(folderPath)}`)
          .expect(200);
        return (response.body as { jobs: QueueJob[] }).jobs.find((job) => job.videoId === videoId);
      },
      (job) => job !== undefined && (job as QueueJob).status === status,
    );

  it('reports the channel name of every indexed folder for the console search link', async () => {
    const folderPath = await env.seedFolder('channel-names', {
      ...videoFiles('chan0000001', 'Film kanału Alfa', { channel: 'Kanał Alfa' }),
      'config.json': folderConfig('https://www.youtube.com/@alfa'),
    });
    env.setFolders('channel-names');
    await env.agent.post('/api/videos/refreshCache').expect(202);
    await waitForRefreshIdle();

    const response = await env.agent.get('/api/videos/channels').expect(200);
    const body = response.body as { channels: string[]; folders: Record<string, string> };

    expect(body.channels).toContain('Kanał Alfa');
    expect(body.folders[folderPath]).toBe('Kanał Alfa');
  });

  it('saves a folder config and serves it back through /api/status', async () => {
    const folderPath = await env.seedFolder('channel-a', {});
    env.setFolders('channel-a');

    const save = await env.agent
      .put('/api/folder/config')
      .send({ folderPath, config: { channelUrl: 'https://www.youtube.com/@deepchannel', category: 'tests' } })
      .expect(200);
    expect(save.body.success).toBe(true);

    const status = await env.agent.get('/api/status').expect(200);
    expect(status.body.videosFolderPath).toEqual([folderPath]);
    expect(status.body.folderConfigs[folderPath]).toMatchObject({
      channelUrl: 'https://www.youtube.com/@deepchannel',
      category: 'tests',
    });
  });

  it('reindexes a seeded folder and serves search, details and a mock-LLM summary', async () => {
    await env.seedFolder('channel-b', videoFiles('vid00000001', 'Kosmici i drony'));
    env.setFolders('channel-b');

    await env.agent.post('/api/videos/refreshCache').expect(202);
    await waitForRefreshIdle();

    // The query has no diacritics — the folded analyzer still matches
    const search = await env.agent.get('/api/videos/search?q=kosmici').expect(200);
    expect(search.body.totalCount).toBe(1);
    expect(search.body.videos[0].title).toBe('Kosmici i drony');

    const baseName = encodeURIComponent('20260101_Kosmici i drony');
    const details = await env.agent.get(`/api/videos/${baseName}/details`).expect(200);
    expect(details.body.details.title).toBe('Kosmici i drony');
    expect(details.body.details.channelName).toBe('Deep test channel');
    expect(details.body.details.subtitles).toHaveLength(1);

    // Summary: the real pipeline reads the subtitle file and calls the mock
    // OpenAI server; the result lands in the disk cache.
    const first = await env.agent.get(`/api/videos/${baseName}/summary`).expect(200);
    expect(first.body.summary).toBe('Fake summary.');
    expect(env.mockOpenai.requests).toHaveLength(1);
    expect(env.mockOpenai.requests.at(0)?.prompt).toContain('Deep test subtitle line.');

    const second = await env.agent.get(`/api/videos/${baseName}/summary`).expect(200);
    expect(second.body.summary).toBe('Fake summary.');
    expect(env.mockOpenai.requests).toHaveLength(1); // cache hit — no second call
  });

  it('walks the model fallback chain when the primary model is rate limited', async () => {
    await env.seedFolder('channel-c', videoFiles('vid00000002', 'Historia filmu'));
    env.setFolders('channel-c');
    await env.agent.post('/api/videos/refreshCache').expect(202);
    await waitForRefreshIdle();

    env.mockOpenai.rateLimitModel('gpt-4o');
    try {
      const response = await env.agent
        .get(`/api/videos/${encodeURIComponent('20260101_Historia filmu')}/summary`)
        .expect(200);
      expect(response.body.summary).toBe('Fake summary.');
      // The env is shared across tests: this test's own two calls are the last ones
      expect(env.mockOpenai.requests.slice(-2).map((request) => request.model)).toEqual(['gpt-4o', 'gpt-4o-mini']);
    } finally {
      env.mockOpenai.clearRateLimits();
    }
  });

  it('downloads a playlist, runs a queue job through the fake yt-dlp and reports it downloaded', async () => {
    const folderPath = await env.seedFolder('channel-d', {
      'config.json': folderConfig('https://www.youtube.com/@deepchannel'),
    });
    env.setFolders('channel-d');

    const playlist = await env.agent.post('/api/folder/download-playlist').send({ folderPath }).expect(200);
    expect(playlist.body.videoCount).toBe(2);

    const enqueue = await env.agent
      .post('/api/folder/queue')
      .send({
        folderPath,
        type: 'download',
        videos: [
          {
            videoId: 'aaaaaaaaaaa',
            videoUrl: 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
            title: 'Fake playlist video 1',
          },
        ],
      })
      .expect(202);
    expect(enqueue.body.skipped).toEqual([]);

    const job = (await waitForJobStatus(folderPath, 'aaaaaaaaaaa', 'done')) as QueueJob;
    expect(job.progress).toBe(100);

    // The fake yt-dlp wrote the video, sidecars and the archive entry
    expect(existsSync(`${folderPath}/20260101_Fake video aaaaaaaaaaa.mp4`)).toBe(true);
    expect(existsSync(`${folderPath}/20260101_Fake video aaaaaaaaaaa.info.json`)).toBe(true);
    expect(existsSync(`${folderPath}/archive.txt`)).toBe(true);

    const list = await env.agent.get(`/api/folder/list?folderPath=${encodeURIComponent(folderPath)}`).expect(200);
    expect(list.body.downloadStatuses.aaaaaaaaaaa).toBe(true);
  });

  it('reports an unreachable Elasticsearch and recovers when it comes back', async () => {
    const firstFolder = await env.seedFolder('es-down-a', {
      ...videoFiles('esdown00001', 'Film bez Elasticsearch'),
      'config.json': folderConfig('https://www.youtube.com/@esdowna'),
      'list.json': JSON.stringify([
        { id: 'esdown00001', title: 'Film bez Elasticsearch', url: 'https://www.youtube.com/watch?v=esdown00001' },
      ]),
    });
    const secondFolder = await env.seedFolder('es-down-b', {
      'config.json': folderConfig('https://www.youtube.com/@esdownb', 'other'),
    });

    // Every status observation uses its own folder set: the answer is cached
    // for 5 s per set, and the test has no business sleeping that out.
    env.setFolders('es-down-a', 'es-down-b');
    await env.agent.post('/api/videos/refreshCache').expect(202);
    await waitForRefreshIdle();

    const healthy = await env.agent.get('/api/status').expect(200);
    const healthyBody = healthy.body as { elasticsearch: string; indexedFolders: string[] };
    expect(healthyBody.elasticsearch).toBe('ok');
    expect(healthyBody.indexedFolders).toContain(firstFolder);
    // No /health call here on purpose: a healthy probe is cached for 5 s, and
    // the point below is what the probe says once the cluster is gone

    await env.fakeEs.stop();
    env.setFolders('es-down-b');

    // The disk-backed status survives, and says why the index data is missing
    const status = await env.agent.get('/api/status').expect(200);
    const statusBody = status.body as { elasticsearch: string; videosFolderPath: string[]; indexedFolders: string[] };
    expect(statusBody.elasticsearch).toBe('down');
    expect(statusBody.videosFolderPath).toContain(secondFolder);
    expect(statusBody.indexedFolders).toEqual([]);

    // Anything that reads documents is a dependency failure, not a crash
    const search = await env.agent.get('/api/videos/search?q=film').expect(503);
    expect(search.body).toEqual({ error: 'Elasticsearch is not reachable', code: 'elasticsearch_unavailable' });

    // And it fails fast: the search client retries transient failures for
    // seconds by design, and a fresh outage skips that budget instead of
    // making the user wait it out twice
    const fastStartedAt = Date.now();
    await env.agent.get('/api/videos/search?q=film').expect(503);
    expect(Date.now() - fastStartedAt).toBeLessThan(1_000);

    // The metric says the same thing for a scrape
    const degradedMetrics = await env.agent.get('/metrics').expect(200);
    expect(degradedMetrics.text).toContain('elasticsearch_up 0');

    // The probe is not cached while it is down, so the recovery is seen at once
    await env.agent.get('/health').expect(503);

    await env.fakeEs.restart();
    env.setFolders('es-down-a', 'es-down-b');

    await env.agent.get('/health').expect(200);
    const recoveredMetrics = await env.agent.get('/metrics').expect(200);
    expect(recoveredMetrics.text).toContain('elasticsearch_up 1');
    const recovered = await env.agent.get('/api/status').expect(200);
    const recoveredBody = recovered.body as { elasticsearch: string; indexedFolders: string[] };
    expect(recoveredBody.elasticsearch).toBe('ok');
    expect(recoveredBody.indexedFolders).toContain(firstFolder);
    const recoveredSearch = await env.agent.get('/api/videos/search?q=film').expect(200);
    expect((recoveredSearch.body as { videos: Array<{ title: string }> }).videos.map((video) => video.title)).toContain(
      'Film bez Elasticsearch',
    );
  }, 45_000);

  it('fails fast with the members-only code instead of retrying', async () => {
    const folderPath = await env.seedFolder('channel-e', {});
    env.setFolders('channel-e');

    await env.agent
      .post('/api/folder/queue')
      .send({ folderPath, type: 'download', videos: [{ videoUrl: 'https://www.youtube.com/watch?v=member11111' }] })
      .expect(202);

    const job = (await waitForJobStatus(folderPath, 'member11111', 'error')) as QueueJob;
    expect(job.error).toMatch(/members-only/i);
    expect(existsSync(`${folderPath}/20260101_Fake video member11111.mp4`)).toBe(false);
  });
});
