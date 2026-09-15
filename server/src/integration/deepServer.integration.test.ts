import { existsSync } from 'node:fs';
import type { QueueJob } from '@shared/api';
import type { DeepServerTestEnv } from '../test/deepServerTestEnv';
import { createDeepServerTestEnv, folderConfig, videoFiles } from '../test/deepServerTestEnv';

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
