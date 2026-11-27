import { existsSync, readdirSync, readFileSync } from 'node:fs';
import fs, { writeFile } from 'node:fs/promises';
import type { QueueJob } from '@videodeck/shared/api';
import {
  QueueJobResponseSchema,
  QueueListResponseSchema,
  QueueSummaryResponseSchema,
  SearchResponseSchema,
  VideoDetailsResponseSchema,
} from '@videodeck/shared/schemas';
import type { DeepServerTestEnv } from '@videodeck/test-infra/deepServerTestEnv';
import {
  createDeepServerTestEnv,
  folderConfig,
  videoFiles,
  YTDLP_ARGV_LOG_NAME,
  YTDLP_TITLES_NAME,
} from '@videodeck/test-infra/deepServerTestEnv';

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

  it('reports the channel name and category of every indexed folder for the channel filter', async () => {
    const folderPath = await env.seedFolder('channel-names', {
      ...videoFiles('chan0000001', 'Film kanału Alfa', { channel: 'Kanał Alfa' }),
      'config.json': folderConfig('https://www.youtube.com/@alfa', 'fpv'),
    });
    env.setFolders('channel-names');
    await env.agent.post('/api/videos/refreshCache').expect(202);
    await waitForRefreshIdle();

    const response = await env.agent.get('/api/videos/channels').expect(200);
    const body = response.body as {
      channels: string[];
      folders: Record<string, string>;
      channelCategories: Record<string, string>;
    };

    expect(body.channels).toContain('Kanał Alfa');
    expect(body.folders[folderPath]).toBe('Kanał Alfa');
    expect(body.channelCategories['Kanał Alfa']).toBe('fpv');
  });

  it('refuses cross-site browser requests on the real API and keeps the local client working', async () => {
    // /api/status reads the configured folders, so this test seeds its own set
    // first: without one it would answer from whatever VIDEOS_FOLDER_PATH the
    // test before it left behind (an empty one is a 500, not the guard's 403).
    await env.seedFolder('cross-site-guard', {
      'config.json': folderConfig('https://www.youtube.com/@crosssite'),
    });
    env.setFolders('cross-site-guard');

    // The Docker UI proxies the API with the token attached, so a request may
    // carry the token and still come from a page nobody trusts. The browser
    // marker decides, before the token is even looked at.
    const crossSite = await env.agent.get('/api/status').set('Sec-Fetch-Site', 'cross-site');
    expect(crossSite.status).toBe(403);

    // Another port on this host is same-site, not cross-site, and is refused
    // unless its origin is on the trusted list.
    const sameSiteUntrusted = await env.agent
      .get('/api/status')
      .set('Sec-Fetch-Site', 'same-site')
      .set('Origin', 'http://localhost:4000');
    expect(sameSiteUntrusted.status).toBe(403);

    const localClient = await env.agent
      .get('/api/status')
      .set('Sec-Fetch-Site', 'same-site')
      .set('Origin', 'http://localhost:3000');
    expect(localClient.status).toBe(200);

    // Clients without the marker (curl, the extension worker) are unaffected
    await env.agent.get('/api/status').expect(200);
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
    // OpenAI server; the result lands in the disk cache. The mock server is
    // shared by the whole file, so the count starts where this test finds it
    // (the fallback-chain test below makes two calls of its own).
    const callsBefore = env.mockOpenai.requests.length;
    const first = await env.agent.get(`/api/videos/${baseName}/summary`).expect(200);
    expect(first.body.summary).toBe('Fake summary.');
    expect(env.mockOpenai.requests).toHaveLength(callsBefore + 1);
    expect(env.mockOpenai.requests.at(callsBefore)?.prompt).toContain('Deep test subtitle line.');

    const second = await env.agent.get(`/api/videos/${baseName}/summary`).expect(200);
    expect(second.body.summary).toBe('Fake summary.');
    expect(env.mockOpenai.requests).toHaveLength(callsBefore + 1); // cache hit — no second call
  });

  it('runs the same pipeline on DeepSeek when its key appears, without a restart', async () => {
    await env.seedFolder('channel-deepseek', videoFiles('vid00000002', 'Streszczenia na DeepSeeku'));
    env.setFolders('channel-deepseek');
    await env.agent.post('/api/videos/refreshCache').expect(202);
    await waitForRefreshIdle();

    // The provider is resolved on every call, so the switch is one environment
    // variable and not a restart. DEEPSEEK_BASE_URL already points at the mock.
    const keyBefore = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = 'test-key';
    try {
      const baseName = encodeURIComponent('20260101_Streszczenia na DeepSeeku');
      const response = await env.agent.get(`/api/videos/${baseName}/summary`).expect(200);

      expect(response.body.summary).toBe('Fake summary.');
      const call = env.mockOpenai.requests.at(-1);
      expect(call?.model).toBe('deepseek-flash');
      // Thinking mode would bill reasoning tokens for a task that needs none
      expect(call?.thinking).toEqual({ type: 'disabled' });
      expect(call?.prompt).toContain('Deep test subtitle line.');
    } finally {
      if (keyBefore === undefined) {
        delete process.env.DEEPSEEK_API_KEY;
      } else {
        process.env.DEEPSEEK_API_KEY = keyBefore;
      }
    }
  });

  it('runs DeepSeek with the reasoning effort from the model variable', async () => {
    await env.seedFolder('channel-effort', videoFiles('vid00000003', 'Wysiłek rozumowania'));
    env.setFolders('channel-effort');
    await env.agent.post('/api/videos/refreshCache').expect(202);
    await waitForRefreshIdle();

    // `name:effort` is the whole setting: the model is bare and the effort turns
    // thinking mode on. The test environment pins these variables to empty.
    const keyBefore = process.env.DEEPSEEK_API_KEY ?? '';
    const modelBefore = process.env.DEEPSEEK_MODEL ?? '';
    process.env.DEEPSEEK_API_KEY = 'test-key';
    process.env.DEEPSEEK_MODEL = 'deepseek-flash:high';
    try {
      const baseName = encodeURIComponent('20260101_Wysiłek rozumowania');
      await env.agent.get(`/api/videos/${baseName}/summary`).expect(200);

      const call = env.mockOpenai.requests.at(-1);
      expect(call?.model).toBe('deepseek-flash');
      expect(call?.thinking).toEqual({ type: 'enabled' });
      expect(call?.reasoningEffort).toBe('high');
    } finally {
      process.env.DEEPSEEK_API_KEY = keyBefore;
      process.env.DEEPSEEK_MODEL = modelBefore;
    }
  });

  it('searches and opens a video that has no thumbnail', async () => {
    // Downloaded with --no-write-thumbnail, or its image lost since: the media
    // and the info.json are on disk, and search used to skip the video
    const withoutThumbnail = Object.fromEntries(
      Object.entries(videoFiles('nothumb0001', 'Bez miniatury')).filter(([name]) => !name.endsWith('.webp')),
    );
    await env.seedFolder('no-thumbnail', withoutThumbnail);
    env.setFolders('no-thumbnail');
    await env.agent.post('/api/videos/refreshCache').expect(202);
    await waitForRefreshIdle();

    const search = await env.agent.get('/api/videos/search?q=miniatury').expect(200);
    expect(search.body.totalCount).toBe(1);
    // The shared contract the client parses pages with takes the item as it is
    const [found] = SearchResponseSchema.parse(search.body).videos;
    expect(found?.title).toBe('Bez miniatury');
    expect(found).not.toHaveProperty('thumbnailPath');

    const details = await env.agent.get('/api/videos/nothumb0001/details').expect(200);
    const parsed = VideoDetailsResponseSchema.parse(details.body).details;
    expect(parsed.videoPath).toBe('20260101_Bez miniatury.mp4');
    expect(parsed).not.toHaveProperty('thumbnailPath');
  });

  it('builds the details from the index and reads the info.json only for its comments', async () => {
    // The route parsed the whole info.json on every view for six short
    // fields the index already holds, and the comment store parsed it again
    const comment = { id: 'Ugx-details', author: 'Viewer', text: 'First comment', like_count: 1 };
    await env.seedFolder(
      'details-from-index',
      videoFiles('details0001', 'Details from the index', { comments: [comment] }),
    );
    env.setFolders('details-from-index');
    await env.agent.post('/api/videos/refreshCache').expect(202);
    await waitForRefreshIdle();
    const readFile = vi.spyOn(fs, 'readFile');
    const infoJsonReads = (): number =>
      readFile.mock.calls.filter(([file]) => String(file).endsWith('20260101_Details from the index.info.json')).length;

    try {
      const first = await env.agent.get('/api/videos/details0001/details').expect(200);
      expect(infoJsonReads()).toBe(1);
      await env.agent.get('/api/videos/details0001/details').expect(200);
      expect(infoJsonReads()).toBe(1);

      expect(VideoDetailsResponseSchema.parse(first.body).details).toMatchObject({
        title: 'Details from the index',
        description: 'Deep test description.',
        uploadDate: '20260101',
        viewCount: 1234,
        likeCount: 56,
        channelName: 'Deep test channel',
        comments: [expect.objectContaining({ id: 'Ugx-details', text: 'First comment' })],
        commentCount: 1,
      });
    } finally {
      readFile.mockRestore();
    }
  });

  it('opens a hand-edited video with a string count and no title', async () => {
    // The index coerces the count and takes the title from the file name; the
    // route read the file again and answered a string count and an empty
    // title, a payload the client's own contract refuses
    await env.seedFolder(
      'details-hand-edited',
      videoFiles('handedit001', 'Edited by hand', { title: undefined, view_count: '1234' }),
    );
    env.setFolders('details-hand-edited');
    await env.agent.post('/api/videos/refreshCache').expect(202);
    await waitForRefreshIdle();

    const response = await env.agent.get('/api/videos/handedit001/details').expect(200);

    expect(VideoDetailsResponseSchema.parse(response.body).details).toMatchObject({
      title: 'Edited by hand',
      viewCount: 1234,
    });
  });

  it('answers a search whose page crosses the result window with a short page, not a 500', async () => {
    await env.seedFolder('window', videoFiles('vid00000010', 'Okno wyników'));
    env.setFolders('window');
    await env.agent.post('/api/videos/refreshCache').expect(202);
    await waitForRefreshIdle();

    // from + size = 10010: a real cluster rejects that page with
    // search_phase_execution_exception, which used to reach the user as a 500.
    const response = await env.agent.get('/api/videos/search?offset=9990&limit=20').expect(200);

    expect(response.body.videos).toEqual([]);
    // The total still describes the query, so a client can tell where the
    // window ends rather than guessing from an empty page
    expect(response.body.totalCount).toBe(1);

    const lastBody = env.fakeEs.searchLog.at(-1)?.body as { from?: number; size?: number };
    expect((lastBody.from ?? 0) + (lastBody.size ?? 0)).toBeLessThanOrEqual(10_000);
  });

  it('answers an offset past the result window with an empty page and the real total', async () => {
    await env.seedFolder('window-past', videoFiles('vid00000011', 'Za oknem'));
    env.setFolders('window-past');
    await env.agent.post('/api/videos/refreshCache').expect(202);
    await waitForRefreshIdle();

    const response = await env.agent.get('/api/videos/search?offset=10000&limit=20').expect(200);

    expect(response.body.videos).toEqual([]);
    expect(response.body.totalCount).toBe(1);

    // A size-0 query is the one shape a real cluster still answers there, and
    // it keeps the total honest instead of guessing
    const lastBody = env.fakeEs.searchLog.at(-1)?.body as { size?: number } | undefined;
    expect(lastBody?.size).toBe(0);
  });

  it('serves every folder of a typed search when one video carries more comment text than the highlighter analyzes', async () => {
    // One comment of 1,100,000 characters, past the 1,000,000 a cluster's
    // highlighter analyzes by default: that hit failed the fetch of its
    // folder's whole shard, so the folder's videos left the page
    const heavyComment = { id: 'Ugx-heavy', author: 'Viewer', text: 'komentarz '.repeat(110_000), like_count: 0 };
    await env.seedFolder('highlight-heavy', {
      ...videoFiles('heavy000001', 'Film z komentarzami', { comments: [heavyComment] }),
      ...videoFiles('heavy000002', 'Film bez komentarzy'),
      'config.json': folderConfig('https://www.youtube.com/@heavy', 'heavy'),
    });
    await env.seedFolder('highlight-light', {
      ...videoFiles('light000001', 'Film z innego folderu'),
      'config.json': folderConfig('https://www.youtube.com/@light', 'light'),
    });
    env.setFolders('highlight-heavy', 'highlight-light');
    await env.agent.post('/api/videos/refreshCache').expect(202);
    await waitForRefreshIdle();

    const both = await env.agent.get('/api/videos/search?q=film').expect(200);
    expect(both.body.totalCount).toBe(3);
    expect((both.body.videos as Array<{ title: string }>).map((video) => video.title).sort()).toEqual([
      'Film bez komentarzy',
      'Film z innego folderu',
      'Film z komentarzami',
    ]);

    // The heavy folder alone is one shard, where the same failure was a 500
    const heavy = await env.agent.get('/api/videos/search?q=film&category=heavy').expect(200);
    expect(heavy.body.totalCount).toBe(2);
    expect(heavy.body.videos).toHaveLength(2);
  });

  it('finds the video a pasted link or bare id names, and nothing for a link the library lacks', async () => {
    // Old-style stems, which hold no id: the text search had nothing to find
    // the id in, and a link matched the newer video through "https", "watch"
    // and "v" in its description
    await env.seedFolder('pasted-links', {
      ...videoFiles('dQw4w9WgXcQ', 'Stary klip', { upload_date: '20200101' }),
      ...videoFiles('newer000001', 'Nowszy klip', {
        upload_date: '20250101',
        description: 'Polecam https://www.youtube.com/watch?v=otherVideo1',
      }),
    });
    env.setFolders('pasted-links');
    await env.agent.post('/api/videos/refreshCache').expect(202);
    await waitForRefreshIdle();

    const found = async (q: string) => {
      const response = await env.agent.get('/api/videos/search').query({ q }).expect(200);
      const body = response.body as { videos: Array<{ videoId?: string }>; totalCount: number };
      return { ids: body.videos.map((video) => video.videoId), total: body.totalCount };
    };

    for (const q of [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://youtu.be/dQw4w9WgXcQ?si=share',
      'dQw4w9WgXcQ',
    ]) {
      expect(await found(q), q).toEqual({ ids: ['dQw4w9WgXcQ'], total: 1 });
    }
    expect(await found('https://www.youtube.com/watch?v=notArchived')).toEqual({ ids: [], total: 0 });
  });

  it('searches, opens and lists channels across 300 configured folders', async () => {
    const folderPath = await env.seedFolder('library-300', {
      ...videoFiles('lib300video', 'Film z dużej biblioteki', { channel: 'Kanał biblioteki' }),
      'config.json': folderConfig('https://www.youtube.com/@library300'),
    });
    env.setFolders('library-300');
    await env.agent.post('/api/videos/refreshCache').expect(202);
    await waitForRefreshIdle();

    // 299 more folders the library lists and nobody has indexed yet, the way a
    // freshly attached drive arrives. Every read names all 300 aliases, and in
    // a _search URL that list alone is about 7.8 KB of request line, which a
    // cluster refuses past 4 KB before it reads a single name.
    const unindexed = Array.from({ length: 299 }, (_unused, index) => `library-300-unindexed-${index}`);
    env.setFolders('library-300', ...unindexed);

    const search = await env.agent.get('/api/videos/search?q=biblioteki').expect(200);
    expect(search.body.totalCount).toBe(1);
    expect(search.body.videos[0].title).toBe('Film z dużej biblioteki');

    const details = await env.agent.get('/api/videos/lib300video/details').expect(200);
    expect(details.body.details.title).toBe('Film z dużej biblioteki');

    const channels = await env.agent.get('/api/videos/channels').expect(200);
    expect(channels.body.folders[folderPath]).toBe('Kanał biblioteki');
    expect(channels.body.channels).toContain('Kanał biblioteki');
  });

  it('indexes videos past 2,147,483,647 views and sorts them by value', async () => {
    // Real counts, not hand edits: the biggest music videos are past three
    // billion views. The integer mapping refused each such video, and a folder
    // holding nothing else failed its whole bulk write.
    await env.seedFolder('views-billions', {
      ...videoFiles('views000003', 'Trzy miliardy', { view_count: 3_000_000_000 }),
      ...videoFiles('views000999', 'Dziewięćset', { view_count: 999 }),
    });
    await env.seedFolder(
      'views-seven-billion',
      videoFiles('views000007', 'Siedem miliardów', { view_count: 7_000_000_000 }),
    );
    env.setFolders('views-billions', 'views-seven-billion');
    await env.agent.post('/api/videos/refreshCache').expect(202);
    await waitForRefreshIdle();

    const status = await env.agent.get('/api/videos/refreshCache/status').expect(200);
    expect(status.body).toMatchObject({ indexed: 3, skipped: 0, errors: [] });

    // By value across both folders: compared as text, 999 came first
    const ranked = await env.agent.get('/api/videos/search?sort=views-desc').expect(200);
    expect((ranked.body.videos as Array<{ title: string }>).map((video) => video.title)).toEqual([
      'Siedem miliardów',
      'Trzy miliardy',
      'Dziewięćset',
    ]);

    const details = await env.agent.get('/api/videos/views000003/details').expect(200);
    expect(details.body.details.viewCount).toBe(3_000_000_000);
  });

  it('reports the document the cluster refused and still indexes the rest of the batch', async () => {
    // The bug class a journey could not see: a per-item bulk failure used to
    // be invisible here, so one refused document either vanished from search
    // without a word or was counted as indexed. A digit string past int64
    // survives toDocument's coercion as a number, and the viewCount mapping
    // (long) refuses it while its siblings in the same batch land.
    await env.seedFolder('bulk-partial', {
      ...videoFiles('bulk00000001', 'Film dobry'),
      ...videoFiles('bulk00000002', 'Film z ogromna liczba wyswietlen', { view_count: '99999999999999999999' }),
      ...videoFiles('bulk00000003', 'Film drugi dobry'),
    });
    env.setFolders('bulk-partial');

    await env.agent.post('/api/videos/refreshCache').expect(202);
    await waitForRefreshIdle();

    // Three documents, one batch: the caller reports the refusal instead of
    // counting all three as indexed, and apart from the videos it could not
    // read, of which there are none here
    const status = await env.agent.get('/api/videos/refreshCache/status').expect(200);
    expect(status.body).toMatchObject({ indexed: 2, skipped: 0, rejected: 1, folderErrors: 0 });

    // And the good documents are searchable, so the batch did not sink
    const search = await env.agent.get('/api/videos/search?q=film').expect(200);
    const titles = (search.body.videos as Array<{ title: string }>).map((item) => item.title);
    expect(titles).toEqual(expect.arrayContaining(['Film dobry', 'Film drugi dobry']));
    expect(titles).not.toContain('Film z ogromna liczba wyswietlen');
    expect(search.body.totalCount).toBe(2);
  });

  it('walks the model fallback chain when the primary model is rate limited', async () => {
    await env.seedFolder('channel-c', videoFiles('vid00000002', 'Historia filmu'));
    env.setFolders('channel-c');
    await env.agent.post('/api/videos/refreshCache').expect(202);
    await waitForRefreshIdle();

    // The app's own logger instance, loaded after the environment is up like
    // every server module this suite touches
    const { logger } = await import('../utils/logger.js');
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {
      /* silence the expected rate-limit warning */
    });
    env.mockOpenai.rateLimitModel('gpt-4o');
    try {
      const response = await env.agent
        .get(`/api/videos/${encodeURIComponent('20260101_Historia filmu')}/summary`)
        .expect(200);
      expect(response.body.summary).toBe('Fake summary.');
      // The env is shared across tests: this test's own two calls are the last ones
      expect(env.mockOpenai.requests.slice(-2).map((request) => request.model)).toEqual(['gpt-4o', 'gpt-4o-mini']);
      // The mock's 429 carries Retry-After: 1, and the real SDK hands it over as
      // a Headers object: the wait has to come from that header
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('(waited 1s)'));
    } finally {
      warn.mockRestore();
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
    // The media landed, so the job is not flagged: the verdict used to read
    // the index from before the job, which never listed a new download
    expect(job.incomplete).toBeUndefined();

    // The fake yt-dlp wrote the video, sidecars and the archive entry
    // The name ends in the id, and the fake's title already holds it
    expect(existsSync(`${folderPath}/20260101_Fake video aaaaaaaaaaa_aaaaaaaaaaa.mp4`)).toBe(true);
    expect(existsSync(`${folderPath}/20260101_Fake video aaaaaaaaaaa_aaaaaaaaaaa.info.json`)).toBe(true);
    expect(existsSync(`${folderPath}/archive.txt`)).toBe(true);

    const list = await env.agent.get(`/api/folder/list?folderPath=${encodeURIComponent(folderPath)}`).expect(200);
    expect(list.body.downloadStatuses.aaaaaaaaaaa).toBe(true);
  });

  describe('a download that finishes while its folder is being reindexed', () => {
    /** Search hits for one term; polled, since the deferred write lands after the reindex reports idle */
    const titlesFor = async (term: string) => {
      const response = await env.agent.get(`/api/videos/search?q=${encodeURIComponent(term)}`).expect(200);
      return (response.body as { videos: Array<{ title: string }> }).videos.map((video) => video.title);
    };

    /**
     * Reindex the folder with its bulk write held, download one video while
     * it waits, then let the reindex finish. The job must end without waiting
     * for the reindex, and the video must reach the version the reindex swaps in.
     */
    async function downloadDuringReindex(folderPath: string, videoId: string): Promise<void> {
      const hold = env.fakeEs.holdRequestsMatching('/_bulk');
      try {
        await env.agent.post('/api/videos/refreshCache').expect(202);
        await hold.reached;
        await env.agent
          .post('/api/folder/queue')
          .send({ folderPath, type: 'download', videos: [{ videoUrl: `https://www.youtube.com/watch?v=${videoId}` }] })
          .expect(202);
        await waitForJobStatus(folderPath, videoId, 'done');
      } finally {
        hold.release();
      }
      await waitForRefreshIdle();
    }

    it('indexes the video into the version the reindex swaps in', async () => {
      const folderPath = await env.seedFolder('channel-reindexing', videoFiles('reindexold1', 'Film sprzed reindeksu'));
      env.setFolders('channel-reindexing');
      await env.agent.post('/api/videos/refreshCache').expect(202);
      await waitForRefreshIdle();

      await downloadDuringReindex(folderPath, 'reindexnew1');

      // Written through the alias during the reindex, the video went into the
      // version the swap deletes
      await waitFor(
        () => titlesFor('reindexnew1'),
        (titles) => (titles as string[]).includes('Fake video reindexnew1'),
      );
      expect(await titlesFor('reindeksu')).toEqual(['Film sprzed reindeksu']);
    }, 30_000);

    it('keeps the first reindex of a folder intact', async () => {
      // No alias yet: a write through it created and promoted a version of its
      // own, and the promotion deleted the version the reindex was writing
      const folderPath = await env.seedFolder(
        'channel-first-reindex',
        videoFiles('firstold001', 'Film pierwszego indeksu'),
      );
      env.setFolders('channel-first-reindex');

      await downloadDuringReindex(folderPath, 'firstnew001');

      const status = await env.agent.get('/api/videos/refreshCache/status').expect(200);
      expect((status.body as { errors: string[] }).errors).toEqual([]);
      await waitFor(
        () => titlesFor('firstnew001'),
        (titles) => (titles as string[]).includes('Fake video firstnew001'),
      );
      expect(await titlesFor('pierwszego')).toEqual(['Film pierwszego indeksu']);
    }, 30_000);
  });

  it('keeps the files of two same-day videos whose titles share a name apart', async () => {
    // Under --restrict-filenames, titles that differ only in letters outside
    // ASCII or in punctuation sanitize to one name. Before the id joined it,
    // the second download rewrote the first one's info.json. The fake names
    // files from the title as it is, so both videos get one title here.
    const folderPath = await env.seedFolder('channel-same-title', {
      [YTDLP_TITLES_NAME]: JSON.stringify({ samettl0001: 'Odcinek', samettl0002: 'Odcinek' }),
    });
    env.setFolders('channel-same-title');

    for (const videoId of ['samettl0001', 'samettl0002']) {
      await env.agent
        .post('/api/folder/queue')
        .send({ folderPath, type: 'download', videos: [{ videoUrl: `https://www.youtube.com/watch?v=${videoId}` }] })
        .expect(202);
      await waitForJobStatus(folderPath, videoId, 'done');
    }

    const infoIds = readdirSync(folderPath)
      .filter((name) => name.endsWith('.info.json'))
      .map((name) => (JSON.parse(readFileSync(`${folderPath}/${name}`, 'utf-8')) as { id: string }).id);
    expect(infoIds.sort()).toEqual(['samettl0001', 'samettl0002']);
  });

  it('refuses folder configs that carry a yt-dlp escape hatch, and stores the safe ones', async () => {
    const folderPath = await env.seedFolder('channel-config-guard', {});
    env.setFolders('channel-config-guard');

    // The vector from the review, over the real API: --alias defines `foo` as
    // --exec, and --foo then runs it.
    const exploit = await env.agent
      .put('/api/folder/config')
      .send({
        folderPath,
        config: {
          channelUrl: 'https://www.youtube.com/@deepchannel',
          extraArgs: ['--alias', 'foo', '--exec {0}', '--foo', `touch ${env.root}/pwned`],
        },
      })
      .expect(400);
    expect((exploit.body as { error: string }).error).toMatch(/extraArgs/);

    const stored = await env.agent
      .put('/api/folder/config')
      .send({
        folderPath,
        config: {
          channelUrl: 'https://www.youtube.com/@deepchannel',
          extraArgs: ['--sleep-requests', '1', '--limit-rate', '2M'],
        },
      })
      .expect(200);
    expect((stored.body as { config: { extraArgs: string[] } }).config.extraArgs).toEqual([
      '--sleep-requests',
      '1',
      '--limit-rate',
      '2M',
    ]);
  });

  it('drops a hand-written escape hatch from config.json before yt-dlp ever sees it', async () => {
    // No API involved: whoever can write to the channel folder gets to write
    // config.json, so the queue must sanitize what it reads from disk.
    const folderPath = await env.seedFolder('channel-hostile-config', {
      [YTDLP_ARGV_LOG_NAME]: '',
      'config.json': JSON.stringify({
        channelUrl: 'https://www.youtube.com/@deepchannel',
        extraArgs: ['--alias', 'foo', '--exec {0}', '--foo', `touch ${env.root}/pwned`, '--sleep-requests', '1'],
      }),
    });
    env.setFolders('channel-hostile-config');

    await env.agent
      .post('/api/folder/queue')
      .send({
        folderPath,
        type: 'download',
        videos: [
          {
            videoId: 'hostile0001',
            videoUrl: 'https://www.youtube.com/watch?v=hostile0001',
            title: 'Hostile config',
          },
        ],
      })
      .expect(202);

    const job = (await waitForJobStatus(folderPath, 'hostile0001', 'done')) as QueueJob;
    expect(job.progress).toBe(100);

    const call = env
      .ytDlpCalls(folderPath)
      .find((candidate) => candidate.args.includes('https://www.youtube.com/watch?v=hostile0001'));
    expect(call).toBeDefined();
    // The safe argument survived, the alias chain did not reach the binary
    expect(call?.args).toContain('--sleep-requests');
    expect(call?.args.join(' ')).not.toMatch(/--alias|--exec|--foo/);
    expect(existsSync(`${env.root}/pwned`)).toBe(false);
  });

  it('ignores a yt-dlp.conf planted in the channel folder, for downloads and playlist fetches', async () => {
    // The second RCE path: yt-dlp reads yt-dlp.conf from its working
    // directory. The fake refuses to run if a config would have been loaded
    // without --ignore-config, so a green run here proves the flag is passed.
    const folderPath = await env.seedFolder('channel-hostile-conf', {
      [YTDLP_ARGV_LOG_NAME]: '',
      'config.json': folderConfig('https://www.youtube.com/@deepchannel'),
      'yt-dlp.conf': "--exec 'touch pwned-from-conf'\n",
    });
    env.setFolders('channel-hostile-conf');

    const playlist = await env.agent.post('/api/folder/download-playlist').send({ folderPath }).expect(200);
    expect((playlist.body as { videoCount: number }).videoCount).toBe(2);

    const playlistCall = env.ytDlpCalls(folderPath).find((candidate) => candidate.args.includes('--flat-playlist'));
    expect(playlistCall?.args).toContain('--ignore-config');
    expect(playlistCall?.cwd).toBe(folderPath);

    await env.agent
      .post('/api/folder/queue')
      .send({
        folderPath,
        type: 'download',
        videos: [
          {
            videoId: 'conf0000001',
            videoUrl: 'https://www.youtube.com/watch?v=conf0000001',
            title: 'Planted config',
          },
        ],
      })
      .expect(202);

    const job = (await waitForJobStatus(folderPath, 'conf0000001', 'done')) as QueueJob;
    expect(job.progress).toBe(100);
    expect(existsSync(`${folderPath}/20260101_Fake video conf0000001_conf0000001.mp4`)).toBe(true);

    const downloadCall = env
      .ytDlpCalls(folderPath)
      .find((candidate) => candidate.args.includes('https://www.youtube.com/watch?v=conf0000001'));
    expect(downloadCall?.args[0]).toBe('--ignore-config');
    expect(downloadCall?.cwd).toBe(folderPath);
    expect(existsSync(`${folderPath}/pwned-from-conf`)).toBe(false);
  });

  it('reports the queue as paused after a restart restores the paused state', async () => {
    // A restart with `paused: true` on disk: the queue stops, and the API must
    // say so. The router used to answer from its own copy of the flag, which a
    // restart never touches.
    const stateFile = process.env.QUEUE_STATE_FILE;
    if (!stateFile) {
      throw new Error('the deep env must point QUEUE_STATE_FILE at its temp root');
    }
    // Loaded lazily: the queue module reads QUEUE_STATE_FILE when it loads, and
    // the deep env sets that variable right before the app module loads.
    const { downloadQueue, restoreQueueState } =
      await vi.importActual<typeof import('../services/downloadQueue')>('../services/downloadQueue');
    // The download above drains the queue asynchronously, and its snapshot is
    // written behind a coalescing window. Let that write land first, or an
    // older `paused: false` snapshot overwrites this one and restore reads it.
    await downloadQueue.whenPersisted();
    await writeFile(stateFile, JSON.stringify({ paused: true, jobs: [] }));

    await expect(restoreQueueState()).resolves.toBe(0);

    const listing = await env.agent.get('/api/folder/queue').expect(200);
    expect(listing.body.paused).toBe(true);

    // Leave the shared queue running for the tests that follow
    const resumed = await env.agent.post('/api/folder/queue/resume?paused=0').expect(200);
    expect(resumed.body).toEqual({ paused: false });
  });

  it('serves the queue as counters and a log-free list, with the log behind the job endpoint', async () => {
    const folderPath = await env.seedFolder('queue-summary', {
      'config.json': folderConfig('https://www.youtube.com/@queuesummary'),
    });
    env.setFolders('queue-summary');

    await env.agent
      .post('/api/folder/queue')
      .send({
        folderPath,
        type: 'download',
        videos: [{ videoUrl: 'https://www.youtube.com/watch?v=queuesum001' }],
      })
      .expect(202);
    const job = (await waitForJobStatus(folderPath, 'queuesum001', 'done')) as QueueJob;
    // The list the poller sees carries no log, so the log tail is read back
    // one job at a time — where the fake yt-dlp announced the file it wrote.
    const list = await env.agent.get('/api/folder/queue').expect(200);
    const listed = QueueListResponseSchema.parse(list.body);
    expect(listed.total).toBeGreaterThanOrEqual(1);
    const listedJob = listed.jobs.find((entry) => entry.videoId === 'queuesum001');
    if (!listedJob) {
      throw new Error('the finished job is missing from the queue list');
    }
    expect(listedJob.id).toBe(job.id);
    expect(listedJob).not.toHaveProperty('log');
    expect(listedJob).not.toHaveProperty('logLineCount');
    // Per job: the queue this file shares holds the jobs of the tests before
    // it, so the size of the whole list says more about the order than the log
    expect(JSON.stringify(listedJob).length).toBeLessThan(1024);

    // The log is reachable, one job at a time
    const detail = await env.agent.get(`/api/folder/queue/${listedJob.id}`).expect(200);
    const detailJob = QueueJobResponseSchema.parse(detail.body).job;
    expect(detailJob.log.join('\n')).toContain('[download] Destination:');
    await env.agent.get('/api/folder/queue/does-not-exist').expect(404);

    // The summary carries the counters per status and per folder, the running
    // jobs without logs, and no job list at all
    const summary = QueueSummaryResponseSchema.parse(
      (await env.agent.get('/api/folder/queue/summaries').expect(200)).body,
    );
    expect(summary.paused).toBe(false);
    expect(summary.counts.done).toBeGreaterThanOrEqual(1);
    expect(summary.folders[folderPath]).toMatchObject({ running: 0, queued: 0, failed: 0 });
    expect(summary.running.every((entry) => !('log' in entry))).toBe(true);
    expect(summary).not.toHaveProperty('jobs');
  });

  it('caps the unfiltered queue list and reports the total it left out', async () => {
    const folderPath = await env.seedFolder('queue-cap', {
      'config.json': folderConfig('https://www.youtube.com/@queuecap'),
    });
    env.setFolders('queue-cap');
    // Paused: the jobs stay queued, so the snapshot below is stable
    await env.agent.post('/api/folder/queue/pause?paused=1').expect(200);
    try {
      const videos = Array.from({ length: 250 }, (_, index) => ({
        videoUrl: `https://www.youtube.com/watch?v=cap${String(index).padStart(8, '0')}`,
      }));
      await env.agent.post('/api/folder/queue').send({ folderPath, type: 'download', videos }).expect(202);

      const list = QueueListResponseSchema.parse((await env.agent.get('/api/folder/queue').expect(200)).body);
      // The queue also holds the jobs of the tests above, so the total is at
      // least this folder's 250 — and the page is capped at 200 of them.
      expect(list.total).toBeGreaterThanOrEqual(250);
      expect(list.jobs).toHaveLength(200);

      // One folder's own jobs are all there: the video rows read their status
      // from this call, and a cap would hide the queued ones.
      const folderList = QueueListResponseSchema.parse(
        (await env.agent.get(`/api/folder/queue?folderPath=${encodeURIComponent(folderPath)}`).expect(200)).body,
      );
      expect(folderList.total).toBe(250);
      expect(folderList.jobs).toHaveLength(250);
    } finally {
      await env.agent.delete('/api/folder/queue').query({ folderPath }).expect(200);
      // Cancelling empties the folder, not the queue's memory: the 250 terminal
      // jobs stay in the list, and the unfiltered page serves its first 200, so
      // whatever test runs next would not find its own job on the page. Clear
      // them the way the console's Clear button does.
      await env.agent.delete('/api/folder/queue/finished').expect(200);
      await env.agent.post('/api/folder/queue/resume?paused=0').expect(200);
    }
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
    expect(readdirSync(folderPath).filter((name) => name.includes('member11111'))).toEqual([]);
  });
});
