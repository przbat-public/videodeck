import type { VideoListItem } from '@videodeck/shared/api';
import type { Mock } from 'vitest';
import { metricsRegistry } from '../metricsRegistry';
import { at } from '../test-utils';
import { logger } from '../utils/logger';
import { isElasticsearchUnavailable } from './elasticsearchErrors';
import {
  buildIndexVersionName,
  bulkIndexDocuments,
  bulkIndexVideos,
  checkElasticsearchConnection,
  clearElasticsearchOutage,
  createIndex,
  createIndexVersion,
  deleteIndex,
  discardIndexVersion,
  estimateDocumentBytes,
  fromDocument,
  getElasticsearchClient,
  getIndexNameFromFolderPath,
  getIndexVersions,
  getRecreateIndicesStatus,
  getVideoByBaseName,
  getVideoByFilePath,
  getVideoByVideoId,
  HIGHLIGHT_MAX_ANALYZED_CHARS,
  indexCacheLogThrottle,
  indexVideo,
  listCachedFolders,
  listChannelsByFolder,
  noteElasticsearchUnavailable,
  promoteIndexVersion,
  recreateAllIndices,
  recreateIndex,
  SEARCH_FIELDS,
  searchVideos,
  searchVideosWithTotal,
  sweepOrphanIndexVersions,
  toDocument,
} from './elasticsearchService';

const mockClient = {
  indices: {
    create: vi.fn(),
    get: vi.fn(),
    exists: vi.fn(),
    existsAlias: vi.fn(),
    getAlias: vi.fn(),
    updateAliases: vi.fn(),
    delete: vi.fn(),
    refresh: vi.fn(),
  },
  bulk: vi.fn(),
  index: vi.fn(),
  msearch: vi.fn(),
  count: vi.fn(),
  ping: vi.fn(),
  deleteByQuery: vi.fn(),
  // The implementation goes into vi.fn itself: the per-test mock reset keeps
  // it, and resetElasticsearchClient chains .catch on what close returns
  close: vi.fn(() => Promise.resolve()),
};

vi.mock('@elastic/elasticsearch', () => ({
  // Production code calls `new Client(...)`, and an arrow function is not
  // constructible: the implementation has to be a function expression. The
  // reference stays lazy, so the factory does not read `mockClient` while the
  // module graph is still initialising.
  // biome-ignore lint/complexity/useArrowFunction: this mock stands in for a class, and an arrow function is not constructible.
  Client: vi.fn(function () {
    return mockClient;
  }),
}));

const FOLDER_A = '/videos/a';
const FOLDER_B = '/videos/b';

/** Mutable so individual tests can simulate "no folders configured" */
const mockFolders = { current: ['/videos/a', '/videos/b'] };

vi.mock('../config', () => ({
  ELASTICSEARCH_URL: 'http://localhost:9200',
  getVideosFolderPaths: () => mockFolders.current,
}));

const ALIAS_A = getIndexNameFromFolderPath(FOLDER_A);
const ALIAS_B = getIndexNameFromFolderPath(FOLDER_B);

const notFound = () => Object.assign(new Error('index_not_found'), { meta: { statusCode: 404 } });

/** The clause a typed phrase is searched with: its words as typed, and within the typo budget */
const phraseQuery = (query: string) => ({
  bool: {
    should: [
      { multi_match: { query, fields: SEARCH_FIELDS, type: 'best_fields' } },
      { multi_match: { query, fields: SEARCH_FIELDS, type: 'best_fields', fuzziness: 'AUTO' } },
    ],
  },
});

/** The creation stamp `buildIndexVersionName` appends, for the current moment */
function stampOfNow(): string {
  return new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, '')
    .slice(0, 17);
}

function video(overrides: Partial<VideoListItem> = {}): VideoListItem {
  return {
    baseName: '20240101_Video',
    videoId: 'vid00000001',
    title: 'Video',
    description: 'Desc',
    videoPath: '20240101_Video.mp4',
    thumbnailPath: '20240101_Video.webp',
    folderPath: FOLDER_A,
    comments: [],
    ...overrides,
  };
}

/** Fixture without a YouTube id (the key is absent, not undefined) */
function videoWithoutId(overrides: Partial<Omit<VideoListItem, 'videoId'>> = {}): VideoListItem {
  const { videoId: _videoId, ...rest } = video(overrides);
  return rest;
}

/** Alias points at the given versions; they are also the only physical indices */
function aliasPointsAt(...indices: string[]) {
  mockClient.indices.getAlias.mockResolvedValue(Object.fromEntries(indices.map((index) => [index, { aliases: {} }])));
  physicalIndices(...indices);
}

/** What `indices.get('<alias>_*')` returns */
function physicalIndices(...indices: string[]) {
  mockClient.indices.get.mockResolvedValue(Object.fromEntries(indices.map((index) => [index, { aliases: {} }])));
}

/** Answer every read with this search response, in the envelope _msearch returns it in */
function answerSearch(response: Record<string, unknown>) {
  mockClient.msearch.mockResolvedValue({ took: 0, responses: [{ status: 200, ...response }] });
}

/** The header line and the body line of the n-th read the service sent */
function sentSearch(call = 0) {
  const [header, body] = at(mockClient.msearch.mock.calls, call)[0].searches;
  return { header, body };
}

describe('elasticsearchService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {
      /* silence expected info logs */
    });
    vi.spyOn(console, 'error').mockImplementation(() => {
      /* silence expected error logs */
    });
    mockFolders.current = ['/videos/a', '/videos/b'];
    // The outage window is module-level state shared by every read path: a
    // test that armed it and did not clear it refused the reads of the tests
    // after it ("Elasticsearch is not reachable" from assertElasticsearchReachable).
    // clearElasticsearchOutage is the seam the outage tests themselves use.
    clearElasticsearchOutage();

    mockClient.indices.create.mockResolvedValue({ acknowledged: true });
    mockClient.indices.exists.mockResolvedValue(false);
    mockClient.indices.existsAlias.mockResolvedValue(true);
    mockClient.indices.updateAliases.mockResolvedValue({ acknowledged: true });
    mockClient.indices.delete.mockResolvedValue({ acknowledged: true });
    mockClient.indices.refresh.mockResolvedValue({});
    mockClient.bulk.mockResolvedValue({ errors: false, items: [] });
    mockClient.index.mockResolvedValue({});
    // An existing alias holds documents unless a test says otherwise
    mockClient.count.mockResolvedValue({ count: 1 });
    aliasPointsAt();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('names', () => {
    it('derives a stable alias from the folder path', () => {
      expect(ALIAS_A).toMatch(/^videos_[0-9a-f]{16}$/);
      expect(getIndexNameFromFolderPath(FOLDER_A)).toBe(ALIAS_A);
      expect(ALIAS_A).not.toBe(ALIAS_B);
    });

    it('builds version names under the alias with a timestamp suffix', () => {
      const name = buildIndexVersionName(FOLDER_A, new Date('2025-03-04T05:06:07.089Z'));
      expect(name).toBe(`${ALIAS_A}_20250304050607089`);
    });
  });

  describe('documents', () => {
    it('flattens comments into commentsText', () => {
      const doc = toDocument(
        video({
          comments: [
            { id: '1', text: 'first' },
            { id: '2', text: '' },
            { id: '3', text: 'second' },
          ],
        }),
      );

      expect(doc).not.toHaveProperty('comments');
      expect(doc.commentsText).toBe('first\nsecond');
    });

    it('omits commentsText when there are no comments', () => {
      expect(toDocument(video())).not.toHaveProperty('commentsText');
    });

    it('restores the API shape with empty comments', () => {
      const item = fromDocument({ ...toDocument(video()), commentsText: 'x' });
      expect(item).not.toHaveProperty('commentsText');
      expect(item).not.toHaveProperty('comments');
      expect(item.baseName).toBe('20240101_Video');
    });

    it('keeps transcripts in the stored document and strips them on the way back', () => {
      const document = toDocument({ ...video(), transcriptText: 'spoken words' });
      expect(document.transcriptText).toBe('spoken words');

      const item = fromDocument(document);
      expect(item).not.toHaveProperty('transcriptText');
      expect(item.baseName).toBe('20240101_Video');
    });
  });

  describe('createIndexVersion', () => {
    it('creates a physical index with the flat mapping and returns its name', async () => {
      const name = await createIndexVersion(FOLDER_A);

      expect(name.startsWith(`${ALIAS_A}_`)).toBe(true);
      expect(mockClient.indices.create).toHaveBeenCalledTimes(1);
      const request = at(mockClient.indices.create.mock.calls, 0)[0];
      expect(request.index).toBe(name);
      expect(request.mappings.properties.commentsText).toEqual({
        type: 'text',
        analyzer: 'polish_folded',
      });
      expect(request.settings.analysis.analyzer.polish_folded.filter).toEqual(['lowercase', 'asciifolding']);
      // A bare keyword: the exact lookup by file name is all that reads it
      expect(request.mappings.properties.baseName).toEqual({ type: 'keyword' });
      expect(request.mappings.properties).not.toHaveProperty('comments');
      expect(request.settings.index).not.toHaveProperty('mapping');
      expect(mockClient.indices.updateAliases).not.toHaveBeenCalled();
    });
  });

  describe('getIndexVersions', () => {
    it('lists indices behind the alias', async () => {
      aliasPointsAt('v1', 'v2');
      expect(await getIndexVersions(FOLDER_A)).toEqual(['v1', 'v2']);
      expect(mockClient.indices.getAlias).toHaveBeenCalledWith({ name: ALIAS_A });
    });

    it('returns an empty list when the alias does not exist', async () => {
      mockClient.indices.getAlias.mockRejectedValue(notFound());
      expect(await getIndexVersions(FOLDER_A)).toEqual([]);
    });

    it('rethrows other errors', async () => {
      mockClient.indices.getAlias.mockRejectedValue(new Error('boom'));
      await expect(getIndexVersions(FOLDER_A)).rejects.toThrow('boom');
    });
  });

  describe('sweepOrphanIndexVersions', () => {
    it('keeps an index this process is still writing into', async () => {
      // The sweep runs at boot, right after the port opens, and a reindex can
      // already be building a physical index that is not behind the alias yet.
      // The name carries its creation stamp, so anything born after this
      // process started is work in progress, not an orphan of a crashed run.
      const createdByThisRun = `${ALIAS_A}_${stampOfNow()}`;
      const orphanFromBefore = `${ALIAS_A}_20200101000000000`;
      aliasPointsAt();
      physicalIndices(orphanFromBefore, createdByThisRun);

      await sweepOrphanIndexVersions([FOLDER_A]);

      const deleted = mockClient.indices.delete.mock.calls.map(([request]) => request.index);
      expect(deleted).toEqual([orphanFromBefore]);
    });
  });

  describe('listCachedFolders', () => {
    it('returns the folders whose alias exists (a cache from a previous disk session)', async () => {
      mockClient.indices.existsAlias.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

      const lookup = await listCachedFolders([FOLDER_A, FOLDER_B]);

      expect(lookup.folders).toEqual(new Set([FOLDER_A]));
      expect(lookup.elasticsearchUp).toBe(true);
      expect(mockClient.indices.existsAlias).toHaveBeenCalledWith({ name: ALIAS_A });
      expect(mockClient.indices.existsAlias).toHaveBeenCalledWith({ name: ALIAS_B });
    });

    it('treats an index a recreation left empty as uncached, so onlyMissing refills it', async () => {
      // `recreateIndex` publishes a fresh EMPTY version behind the alias. The
      // alias alone then says "cached" while the folder is not searchable at
      // all, so a reindex with onlyMissing skipped every folder and reported
      // "nothing to do" over an empty library.
      mockClient.count.mockResolvedValue({ count: 0 });

      const lookup = await listCachedFolders([FOLDER_A]);

      expect(lookup.folders).toEqual(new Set());
      expect(lookup.elasticsearchUp).toBe(true);
      expect(mockClient.count).toHaveBeenCalledWith({ index: ALIAS_A });
    });

    it('treats a failed alias check as uncached instead of throwing', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {
        /* silence the expected warning */
      });
      mockClient.indices.existsAlias.mockRejectedValueOnce(new Error('alias lookup exploded'));

      const lookup = await listCachedFolders([FOLDER_A]);

      expect(lookup.folders).toEqual(new Set());
      // A single odd failure is not "the cluster is down"
      expect(lookup.elasticsearchUp).toBe(true);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Cannot check the index cache of /videos/a'));
      warn.mockRestore();
    });

    it('reports an unreachable cluster once instead of warning per folder', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {
        /* silence the expected warning */
      });
      const connectionError = (): Error =>
        Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9200'), {
          name: 'ConnectionError',
          code: 'ECONNREFUSED',
        });
      mockClient.indices.existsAlias.mockRejectedValue(connectionError());
      indexCacheLogThrottle.reset();

      const lookup = await listCachedFolders([FOLDER_A, FOLDER_B]);

      expect(lookup.folders).toEqual(new Set());
      expect(lookup.elasticsearchUp).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('Cannot check the index cache of 2 folder(s)');
      warn.mockRestore();
    });
  });

  describe('fail-fast while Elasticsearch is down', () => {
    afterEach(() => {
      clearElasticsearchOutage();
      mockClient.msearch.mockReset();
    });

    it('refuses a read immediately instead of waiting for the client retries', async () => {
      noteElasticsearchUnavailable();

      await expect(searchVideosWithTotal('robot arm')).rejects.toThrow('Elasticsearch is not reachable');
      // The whole point: no request left the process
      expect(mockClient.msearch).not.toHaveBeenCalled();
    });

    it('lets reads through again once the window has passed', async () => {
      const now = vi.spyOn(Date, 'now');
      now.mockReturnValue(1_000);
      noteElasticsearchUnavailable();
      now.mockReturnValue(10_000);
      answerSearch({ hits: { hits: [], total: { value: 0 } } });

      await searchVideosWithTotal('robot arm');
      expect(mockClient.msearch).toHaveBeenCalled();
      now.mockRestore();
    });

    it('lets reads through again after a healthy probe', async () => {
      noteElasticsearchUnavailable();
      mockClient.ping.mockResolvedValue({});
      await checkElasticsearchConnection();
      answerSearch({ hits: { hits: [], total: { value: 0 } } });

      await searchVideosWithTotal('robot arm');
      expect(mockClient.msearch).toHaveBeenCalled();
    });

    it('lets a read through when a stale failure lands right after a healthy probe', async () => {
      // The status page and the queue keep polling, so a request that failed
      // on the client the probe just replaced can land after the outage was
      // cleared and arm the window again. The cluster answered moments ago, so
      // the next read has to try: refusing it showed an empty search for a
      // cluster that was up.
      noteElasticsearchUnavailable();
      mockClient.ping.mockResolvedValue({});
      await checkElasticsearchConnection();
      // ... and a request that failed on the client it replaced lands after
      noteElasticsearchUnavailable();
      answerSearch({ hits: { hits: [], total: { value: 0 } } });

      await searchVideosWithTotal('robot arm');

      expect(mockClient.msearch).toHaveBeenCalled();
    });

    it('still refuses a read when the failure is not stale', async () => {
      // Same shape without the healthy probe in between: no grace applies, so
      // the fail-fast behaviour the window exists for is untouched.
      const now = vi.spyOn(Date, 'now');
      now.mockReturnValue(50_000);
      clearElasticsearchOutage();
      noteElasticsearchUnavailable();
      mockClient.msearch.mockReset();

      await expect(searchVideosWithTotal('robot arm')).rejects.toThrow('Elasticsearch is not reachable');
      expect(mockClient.msearch).not.toHaveBeenCalled();
      now.mockRestore();
    });

    it('publishes the state as a metric', async () => {
      const gauge = metricsRegistry.getSingleMetric('elasticsearch_up') as {
        get: () => Promise<{ values: Array<{ value: number }> }>;
      };

      noteElasticsearchUnavailable();
      expect((await gauge.get()).values[0]?.value).toBe(0);

      mockClient.ping.mockResolvedValue({});
      await checkElasticsearchConnection();
      expect((await gauge.get()).values[0]?.value).toBe(1);
    });
  });

  describe('checkElasticsearchConnection', () => {
    it('replaces the long-lived client once a failed request is followed by a healthy probe', async () => {
      const { Client } = (await vi.importMock('@elastic/elasticsearch')) as { Client: Mock };
      Client.mockClear();
      mockClient.ping.mockResolvedValue({});
      await checkElasticsearchConnection();
      getElasticsearchClient();
      // The probe client plus the long-lived one
      const baseline = Client.mock.calls.length;

      // A request failed, and the next probe finds the cluster back
      noteElasticsearchUnavailable();
      mockClient.ping.mockResolvedValue({});
      expect(await checkElasticsearchConnection()).toBe(true);

      // The app builds a fresh pool instead of reusing the one the outage left
      // behind with its exponential resurrect backoff
      getElasticsearchClient();
      expect(Client.mock.calls.length).toBe(baseline + 1);

      // A healthy probe without a failure in between does not rebuild it
      expect(await checkElasticsearchConnection()).toBe(true);
      getElasticsearchClient();
      expect(Client.mock.calls.length).toBe(baseline + 1);
    });

    it('arms the reset when the probe itself fails', async () => {
      const { Client } = (await vi.importMock('@elastic/elasticsearch')) as { Client: Mock };
      Client.mockClear();
      mockClient.ping.mockResolvedValue({});
      await checkElasticsearchConnection();
      getElasticsearchClient();
      const baseline = Client.mock.calls.length;

      // The probe itself could not reach the cluster
      mockClient.ping.mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:9200'));
      expect(await checkElasticsearchConnection()).toBe(false);

      // The next healthy probe rebuilds the long-lived client, once
      mockClient.ping.mockResolvedValue({});
      expect(await checkElasticsearchConnection()).toBe(true);
      getElasticsearchClient();
      expect(Client.mock.calls.length).toBe(baseline + 1);

      expect(await checkElasticsearchConnection()).toBe(true);
      getElasticsearchClient();
      expect(Client.mock.calls.length).toBe(baseline + 1);
    });
  });

  describe('promoteIndexVersion', () => {
    it('swaps the alias atomically and drops the previous version', async () => {
      aliasPointsAt(`${ALIAS_A}_old`);

      await promoteIndexVersion(FOLDER_A, `${ALIAS_A}_new`);

      expect(mockClient.indices.refresh).toHaveBeenCalledWith({ index: `${ALIAS_A}_new` });
      expect(mockClient.indices.updateAliases).toHaveBeenCalledTimes(1);
      expect(mockClient.indices.updateAliases).toHaveBeenCalledWith({
        actions: [
          { remove: { index: `${ALIAS_A}_old`, alias: ALIAS_A } },
          { add: { index: `${ALIAS_A}_new`, alias: ALIAS_A } },
        ],
      });
      expect(mockClient.indices.delete).toHaveBeenCalledWith({
        index: `${ALIAS_A}_old`,
        ignore_unavailable: true,
      });
      expect(mockClient.indices.delete).not.toHaveBeenCalledWith(expect.objectContaining({ index: ALIAS_A }));
    });

    it('aborts before the alias swap when the orphan listing fails', async () => {
      // The listing feeds the stale set, which used to be computed after the
      // swap and outside any guard. A cluster that refused that one call made
      // promoteIndexVersion reject, and the caller then discarded the index the
      // alias already pointed at: every search answered empty until a full
      // reindex. Listing first means the alias only moves once the promotion
      // can no longer fail.
      aliasPointsAt(`${ALIAS_A}_old`);
      mockClient.indices.get.mockRejectedValue(new Error('listing refused'));

      await expect(promoteIndexVersion(FOLDER_A, `${ALIAS_A}_new`)).rejects.toThrow('listing refused');

      expect(mockClient.indices.updateAliases).not.toHaveBeenCalled();
      expect(mockClient.indices.delete).not.toHaveBeenCalled();
    });

    it('sweeps orphaned versions left by a crashed reindex', async () => {
      aliasPointsAt(`${ALIAS_A}_old`);
      physicalIndices(`${ALIAS_A}_old`, `${ALIAS_A}_orphan`, `${ALIAS_A}_new`);

      await promoteIndexVersion(FOLDER_A, `${ALIAS_A}_new`);

      expect(mockClient.indices.get).toHaveBeenCalledWith(
        expect.objectContaining({ index: `${ALIAS_A}_*`, ignore_unavailable: true }),
      );
      // only the old version was behind the alias, so only it is removed from it
      expect(mockClient.indices.updateAliases).toHaveBeenCalledWith({
        actions: [
          { remove: { index: `${ALIAS_A}_old`, alias: ALIAS_A } },
          { add: { index: `${ALIAS_A}_new`, alias: ALIAS_A } },
        ],
      });
      const deleted = mockClient.indices.delete.mock.calls.map(([req]) => req.index).sort();
      expect(deleted).toEqual([`${ALIAS_A}_old`, `${ALIAS_A}_orphan`]);
    });

    it('deletes old versions only after the alias was switched', async () => {
      aliasPointsAt(`${ALIAS_A}_old`);
      const order: string[] = [];
      mockClient.indices.updateAliases.mockImplementation(async () => {
        order.push('swap');
      });
      mockClient.indices.delete.mockImplementation(async () => {
        order.push('delete');
      });

      await promoteIndexVersion(FOLDER_A, `${ALIAS_A}_new`);

      expect(order).toEqual(['swap', 'delete']);
    });

    it('replaces a legacy concrete index that carries the alias name', async () => {
      mockClient.indices.getAlias.mockRejectedValue(notFound());
      mockClient.indices.exists.mockResolvedValue(true);
      mockClient.indices.existsAlias.mockResolvedValue(false);

      await promoteIndexVersion(FOLDER_A, `${ALIAS_A}_new`);

      expect(mockClient.indices.delete).toHaveBeenCalledWith({ index: ALIAS_A });
      expect(mockClient.indices.updateAliases).toHaveBeenCalledWith({
        actions: [{ add: { index: `${ALIAS_A}_new`, alias: ALIAS_A } }],
      });
      const deleteOrder = at(mockClient.indices.delete.mock.invocationCallOrder, 0);
      const swapOrder = at(mockClient.indices.updateAliases.mock.invocationCallOrder, 0);
      expect(deleteOrder).toBeLessThan(swapOrder);
    });

    it('just adds the alias on a fresh cluster', async () => {
      mockClient.indices.getAlias.mockRejectedValue(notFound());
      mockClient.indices.exists.mockResolvedValue(false);

      await promoteIndexVersion(FOLDER_A, `${ALIAS_A}_new`);

      expect(mockClient.indices.delete).not.toHaveBeenCalled();
      expect(mockClient.indices.updateAliases).toHaveBeenCalledWith({
        actions: [{ add: { index: `${ALIAS_A}_new`, alias: ALIAS_A } }],
      });
    });

    it('does not remove the index it is promoting even if the alias already points at it', async () => {
      aliasPointsAt(`${ALIAS_A}_new`);

      await promoteIndexVersion(FOLDER_A, `${ALIAS_A}_new`);

      expect(mockClient.indices.delete).not.toHaveBeenCalled();
      expect(mockClient.indices.updateAliases).toHaveBeenCalledWith({
        actions: [{ add: { index: `${ALIAS_A}_new`, alias: ALIAS_A } }],
      });
    });
  });

  describe('discardIndexVersion', () => {
    it('deletes the index, tolerating a missing one', async () => {
      await discardIndexVersion('videos_x_1');
      expect(mockClient.indices.delete).toHaveBeenCalledWith({
        index: 'videos_x_1',
        ignore_unavailable: true,
      });
    });
  });

  describe('createIndex / recreateIndex / deleteIndex', () => {
    it('createIndex is a no-op when the alias exists', async () => {
      mockClient.indices.existsAlias.mockResolvedValue(true);

      await createIndex(FOLDER_A);

      expect(mockClient.indices.create).not.toHaveBeenCalled();
      expect(mockClient.indices.updateAliases).not.toHaveBeenCalled();
    });

    it('createIndex publishes an empty version when the alias is missing', async () => {
      mockClient.indices.existsAlias.mockResolvedValue(false);
      mockClient.indices.getAlias.mockRejectedValue(notFound());

      await createIndex(FOLDER_A);

      expect(mockClient.indices.create).toHaveBeenCalledTimes(1);
      const created = at(mockClient.indices.create.mock.calls, 0)[0].index;
      expect(mockClient.indices.updateAliases).toHaveBeenCalledWith({
        actions: [{ add: { index: created, alias: ALIAS_A } }],
      });
    });

    it('recreateIndex always publishes a fresh empty version', async () => {
      aliasPointsAt(`${ALIAS_A}_old`);

      await recreateIndex(FOLDER_A);

      expect(mockClient.indices.create).toHaveBeenCalledTimes(1);
      expect(mockClient.indices.delete).toHaveBeenCalledWith({
        index: `${ALIAS_A}_old`,
        ignore_unavailable: true,
      });
    });

    it('deleteIndex removes every version behind the alias', async () => {
      aliasPointsAt('v1', 'v2');

      await deleteIndex(FOLDER_A);

      expect(mockClient.indices.delete).toHaveBeenCalledWith({
        index: 'v1',
        ignore_unavailable: true,
      });
      expect(mockClient.indices.delete).toHaveBeenCalledWith({
        index: 'v2',
        ignore_unavailable: true,
      });
    });

    it('deleteIndex removes a legacy concrete index', async () => {
      mockClient.indices.getAlias.mockRejectedValue(notFound());
      mockClient.indices.exists.mockResolvedValue(true);

      await deleteIndex(FOLDER_A);

      expect(mockClient.indices.delete).toHaveBeenCalledWith({ index: ALIAS_A });
    });
  });

  describe('createIndex under concurrency', () => {
    /** Alias target plus the documents of every physical index */
    interface EsState {
      indices: Map<string, Set<string>>;
      aliasTarget: string | undefined;
    }

    interface AliasAction {
      add?: { index: string };
      remove?: { index: string };
    }

    /**
     * Stateful stand-in for the calls createIndex and indexVideo make, with
     * the cluster's own failure modes: creating an existing index fails and
     * refreshing a deleted one 404s.
     */
    const esExistsAlias = (state: EsState) => async (): Promise<boolean> => state.aliasTarget !== undefined;

    const esCreate =
      (state: EsState) =>
      async (params: { index: string }): Promise<{ acknowledged: boolean }> => {
        if (state.indices.has(params.index)) {
          throw Object.assign(new Error('resource_already_exists_exception'), { meta: { statusCode: 400 } });
        }
        state.indices.set(params.index, new Set());
        return { acknowledged: true };
      };

    const esRefresh =
      (state: EsState) =>
      async (params: { index: string }): Promise<Record<string, never>> => {
        if (!state.indices.has(params.index)) {
          throw notFound();
        }
        return {};
      };

    const esGetAlias = (state: EsState) => async (): Promise<Record<string, { aliases: Record<string, never> }>> => {
      if (state.aliasTarget === undefined) {
        throw notFound();
      }
      return { [state.aliasTarget]: { aliases: {} } };
    };

    const esExists =
      (state: EsState) =>
      async (params: { index: string }): Promise<boolean> =>
        state.indices.has(params.index);

    /** Apply one remove/add alias action to the state */
    function applyAliasAction(state: EsState, action: AliasAction): void {
      if (action.remove && state.aliasTarget === action.remove.index) {
        state.aliasTarget = undefined;
      }
      if (action.add) {
        state.aliasTarget = action.add.index;
      }
    }

    const esUpdateAliases =
      (state: EsState) =>
      async (params: { actions: AliasAction[] }): Promise<{ acknowledged: boolean }> => {
        for (const action of params.actions) {
          applyAliasAction(state, action);
        }
        return { acknowledged: true };
      };

    const esGet =
      (state: EsState) =>
      async (params: { index: string }): Promise<Record<string, { aliases: Record<string, never> }>> => {
        const prefix = params.index.replace(/\*$/, '');
        const names = [...state.indices.keys()].filter((name) => name.startsWith(prefix));
        return Object.fromEntries(names.map((name) => [name, { aliases: {} }]));
      };

    const esDelete =
      (state: EsState) =>
      async (params: { index: string }): Promise<{ acknowledged: boolean }> => {
        state.indices.delete(params.index);
        return { acknowledged: true };
      };

    const esIndex =
      (state: EsState) =>
      async (params: { index: string; id: string }): Promise<Record<string, never>> => {
        const documents = state.indices.get(state.aliasTarget ?? params.index);
        if (!documents) {
          throw notFound();
        }
        documents.add(params.id);
        return {};
      };

    function installStatefulElasticsearch(): EsState {
      const state: EsState = { indices: new Map(), aliasTarget: undefined };
      mockClient.indices.existsAlias.mockImplementation(esExistsAlias(state));
      mockClient.indices.create.mockImplementation(esCreate(state));
      mockClient.indices.refresh.mockImplementation(esRefresh(state));
      mockClient.indices.getAlias.mockImplementation(esGetAlias(state));
      mockClient.indices.exists.mockImplementation(esExists(state));
      mockClient.indices.updateAliases.mockImplementation(esUpdateAliases(state));
      mockClient.indices.get.mockImplementation(esGet(state));
      mockClient.indices.delete.mockImplementation(esDelete(state));
      mockClient.index.mockImplementation(esIndex(state));
      return state;
    }

    /** A promise plus its settle function, for holding two callers in flight */
    function deferred(): { promise: Promise<void>; resolve: () => void } {
      let resolve = () => {
        /* replaced below */
      };
      const promise = new Promise<void>((settle) => {
        resolve = settle;
      });
      return { promise, resolve };
    }

    it('keeps both documents when two first-time creations race for the same folder', async () => {
      const state = installStatefulElasticsearch();
      // Two jobs finishing together check the alias before either has created
      // its index; the barrier holds both checks open for exactly that window.
      const bothChecked = deferred();
      let checks = 0;
      mockClient.indices.existsAlias.mockImplementation(async () => {
        checks += 1;
        if (checks === 2) {
          bothChecked.resolve();
        }
        await Promise.race([bothChecked.promise, new Promise((resolve) => setTimeout(resolve, 50))]);
        return false;
      });

      await Promise.all([
        indexVideo(video({ videoId: 'vid00000001', baseName: '20240101_First' })),
        indexVideo(video({ videoId: 'vid00000002', baseName: '20240101_Second' })),
      ]);

      const versions = await getIndexVersions(FOLDER_A);
      expect(versions).toHaveLength(1);
      expect([...(state.indices.get(versions[0] ?? '') ?? [])].sort()).toEqual(['vid00000001', 'vid00000002']);
    });

    it('lets a later creation retry after the in-flight one failed', async () => {
      mockClient.indices.existsAlias.mockResolvedValue(false);
      mockClient.indices.create.mockRejectedValueOnce(new Error('ES is down'));

      await expect(createIndex(FOLDER_A)).rejects.toThrow('ES is down');
      await createIndex(FOLDER_A);

      expect(mockClient.indices.create).toHaveBeenCalledTimes(2);
      expect(mockClient.indices.updateAliases).toHaveBeenCalledTimes(1);
    });
  });

  describe('recreateAllIndices', () => {
    beforeEach(() => {
      aliasPointsAt(`${ALIAS_A}_old`, `${ALIAS_B}_old`);
    });

    it('recreates every folder and reports the full run in the shared status', async () => {
      expect(getRecreateIndicesStatus().running).toBe(false);

      await recreateAllIndices();

      const status = getRecreateIndicesStatus();
      expect(status.running).toBe(false);
      expect(status.foldersDone).toBe(2);
      expect(status.foldersTotal).toBe(2);
      expect(status.errors).toEqual([]);
      expect(status.startedAt).toBeDefined();
      expect(status.finishedAt).toBeDefined();
      expect(mockClient.indices.updateAliases).toHaveBeenCalledTimes(2);
    });

    it('records a per-folder failure and continues with the remaining folders', async () => {
      mockClient.indices.create.mockRejectedValueOnce(new Error('ES is down'));

      await recreateAllIndices();

      const status = getRecreateIndicesStatus();
      expect(status.running).toBe(false);
      expect(status.foldersDone).toBe(2);
      expect(status.errors).toHaveLength(1);
      expect(status.errors[0]).toContain('/videos/a');
      expect(status.errors[0]).toContain('ES is down');
      expect(status.lastError).toContain('/videos/a');
      expect(mockClient.indices.updateAliases).toHaveBeenCalledTimes(1);
    });

    it('refuses a concurrent run', async () => {
      const first = recreateAllIndices();

      await expect(recreateAllIndices()).rejects.toThrow('Index recreation is already running');

      await first;
      expect(getRecreateIndicesStatus().running).toBe(false);
    });
  });

  describe('indexVideo', () => {
    it('upserts the flattened document through the alias', async () => {
      await indexVideo(video({ comments: [{ id: '1', text: 'hi' }] }));

      expect(mockClient.index).toHaveBeenCalledWith({
        index: ALIAS_A,
        id: 'vid00000001',
        document: expect.objectContaining({ commentsText: 'hi' }),
        refresh: true,
      });
      expect(at(mockClient.index.mock.calls, 0)[0].document).not.toHaveProperty('comments');
    });

    it('falls back to baseName as id', async () => {
      await indexVideo(videoWithoutId());
      expect(at(mockClient.index.mock.calls, 0)[0].id).toBe('20240101_Video');
    });
  });

  describe('bulkIndexVideos', () => {
    it('writes everything into the given physical index without refreshing', async () => {
      const videos = [
        video({ videoId: 'a', comments: [{ id: '1', text: 'c1' }] }),
        video({ videoId: 'b', baseName: 'other', folderPath: FOLDER_B }),
      ];

      await bulkIndexVideos(videos, { index: 'videos_target', refresh: false });

      expect(mockClient.bulk).toHaveBeenCalledTimes(1);
      const { operations } = at(mockClient.bulk.mock.calls, 0)[0];
      expect(operations).toHaveLength(4);
      expect(operations[0]).toEqual({ index: { _index: 'videos_target', _id: 'a' } });
      expect(operations[1]).toMatchObject({ videoId: 'a', commentsText: 'c1' });
      expect(operations[1]).not.toHaveProperty('comments');
      expect(operations[2]).toEqual({ index: { _index: 'videos_target', _id: 'b' } });
      expect(mockClient.indices.refresh).not.toHaveBeenCalled();
      expect(mockClient.indices.create).not.toHaveBeenCalled();
    });

    it('groups by folder alias and refreshes when no index is given', async () => {
      await bulkIndexVideos([
        video({ videoId: 'a' }),
        video({ videoId: 'b', folderPath: FOLDER_B }),
        video({ videoId: 'c' }),
      ]);

      expect(mockClient.bulk).toHaveBeenCalledTimes(2);
      const targets = mockClient.bulk.mock.calls.map(([req]) => req.operations[0].index._index).sort();
      expect(targets).toEqual([ALIAS_A, ALIAS_B].sort());
      expect(mockClient.indices.refresh).toHaveBeenCalledWith({ index: ALIAS_A });
      expect(mockClient.indices.refresh).toHaveBeenCalledWith({ index: ALIAS_B });
    });

    it('does nothing for an empty list', async () => {
      await bulkIndexVideos([]);
      expect(mockClient.bulk).not.toHaveBeenCalled();
    });

    it('skips per-item bulk errors instead of failing the whole batch', async () => {
      mockClient.bulk.mockResolvedValue({
        errors: true,
        items: [
          { index: { _id: 'a', status: 201 } },
          { index: { _id: 'b', status: 400, error: { reason: 'mapper_parsing_exception' } } },
        ],
      });

      await expect(
        bulkIndexVideos([video({ videoId: 'a' }), video({ videoId: 'b' })], { index: 'x' }),
      ).resolves.toEqual({
        indexed: 1,
        skipped: 1,
      });
    });

    it('throws when every document in a bulk fails (protects the alias swap)', async () => {
      mockClient.bulk.mockResolvedValue({
        errors: true,
        items: [
          { index: { _id: 'a', status: 400, error: { reason: 'mapper_parsing_exception' } } },
          { index: { _id: 'b', status: 400, error: { reason: 'mapper_parsing_exception' } } },
        ],
      });

      await expect(bulkIndexVideos([video({ videoId: 'a' }), video({ videoId: 'b' })], { index: 'x' })).rejects.toThrow(
        'Bulk indexing failed for all 2 videos',
      );
    });
  });

  describe('bulkIndexDocuments', () => {
    it('writes the documents as-is with videoId (or baseName) as id', async () => {
      await bulkIndexDocuments(
        'videos_target',
        [toDocument(video({ videoId: 'a' })), toDocument(videoWithoutId({ baseName: 'nb' }))],
        false,
      );

      const { operations } = at(mockClient.bulk.mock.calls, 0)[0];
      expect(operations[0]).toEqual({ index: { _index: 'videos_target', _id: 'a' } });
      expect(operations[2]).toEqual({ index: { _index: 'videos_target', _id: 'nb' } });
      expect(mockClient.indices.refresh).not.toHaveBeenCalled();
    });

    it('refreshes by default and skips empty batches', async () => {
      await bulkIndexDocuments('x', []);
      expect(mockClient.bulk).not.toHaveBeenCalled();

      await bulkIndexDocuments('x', [toDocument(video())]);
      expect(mockClient.indices.refresh).toHaveBeenCalledWith({ index: 'x' });
    });
  });

  describe('estimateDocumentBytes', () => {
    it('grows with the text fields', () => {
      const small = estimateDocumentBytes(toDocument(video()));
      const big = estimateDocumentBytes(toDocument(video({ comments: [{ id: '1', text: 'x'.repeat(10_000) }] })));
      expect(big - small).toBe(10_000);
      expect(small).toBeGreaterThan(0);
    });
  });

  describe('searchVideos', () => {
    const hit = (source: Record<string, unknown>, id = 'id') => ({ _id: id, _source: source });

    beforeEach(() => {
      answerSearch({ hits: { hits: [] } });
    });

    it('searches all folder aliases with commentsText in the fields and out of the payload', async () => {
      answerSearch({
        hits: { hits: [hit({ ...toDocument(video()), commentsText: 'leak' })] },
      });

      const results = await searchVideos('robot arm', 'views-desc');

      const { header, body: request } = sentSearch();
      // The alias list rides in the _msearch header, never in the URL, whose
      // request line a cluster caps at 4 KB
      expect(header).toEqual({ index: [ALIAS_A, ALIAS_B], ignore_unavailable: true });
      expect(at(mockClient.msearch.mock.calls, 0)[0]).not.toHaveProperty('index');
      expect(request).not.toHaveProperty('ignore_unavailable');
      // The words as typed sit next to the fuzzy clause: a fuzzy clause alone
      // expands to nothing in a folder that holds no near word in a field, so
      // the DFS round never read that field's statistics there, and a title
      // match in a one-video folder lost to a comment match in a big one
      expect(request.query).toEqual(phraseQuery('robot arm'));
      expect(SEARCH_FIELDS).toContain('commentsText');
      // The file name is no search field: new stems are one token under the
      // standard tokenizer, and a foreign-named file's words outscored titles
      expect(SEARCH_FIELDS.filter((field) => field.startsWith('baseName'))).toEqual([]);
      expect(request.sort).toEqual([{ viewCount: { order: 'desc', missing: '_last' } }]);
      expect(request.from).toBe(0);
      expect(request.size).toBe(100);
      expect(request._source).toEqual({
        excludes: ['commentsText', 'transcriptText', 'description', 'videoPath', 'subtitlePath', 'likeCount'],
      });

      expect(results).toHaveLength(1);
      expect(at(results, 0)).not.toHaveProperty('commentsText');
      expect(at(results, 0)).not.toHaveProperty('comments');
    });

    it('returns the query-aware total from hits.total (track_total_hits)', async () => {
      answerSearch({
        hits: {
          total: { value: 3, relation: 'eq' },
          hits: [hit(toDocument(video()), 'a'), hit(toDocument(video()), 'b'), hit(toDocument(video()), 'c')],
        },
      });

      const result = await searchVideosWithTotal('robot arm');

      expect(result.total).toBe(3);
      expect(result.videos).toHaveLength(3);
      expect(sentSearch().body.track_total_hits).toBe(true);
    });

    it('uses match_all for blank queries and sorts by date by default', async () => {
      await searchVideos('   ');

      const request = sentSearch().body;
      expect(request.query).toEqual({ match_all: {} });
      expect(request.sort).toEqual([{ uploadDate: { order: 'desc', missing: '_last' } }]);
    });

    it('refuses to search when no folders are configured (an empty index list would mean all indices)', async () => {
      mockFolders.current = [];

      await expect(searchVideos('q')).rejects.toThrow(/No video folders configured/);
      expect(mockClient.msearch).not.toHaveBeenCalled();
    });

    it('omits the sort for relevance, letting Elasticsearch order by score', async () => {
      await searchVideos('q', 'relevance');

      const request = sentSearch().body;
      expect(request.sort).toEqual([]);
    });

    it('ranks a phrase by relevance by default, scored with the statistics of every folder', async () => {
      await searchVideos('robot');

      const { header, body } = sentSearch();
      expect(body.sort).toEqual([]);
      // Every folder is an index of one shard, and per-shard term statistics
      // scored a match in a small folder far above the same match in a big one
      expect(header.search_type).toBe('dfs_query_then_fetch');
    });

    it('asks for no extra statistics round trip when the page is not ranked by a phrase', async () => {
      await searchVideos('robot', 'date-desc');
      await searchVideos('   ', 'relevance');

      expect(sentSearch(0).header).not.toHaveProperty('search_type');
      expect(sentSearch(1).header).not.toHaveProperty('search_type');
    });

    it('fails loudly on hits without _source', async () => {
      answerSearch({ hits: { hits: [{ _id: 'x' }] } });
      await expect(searchVideos('q')).rejects.toThrow('has no _source');
    });

    it('reads a search no shard could serve yet as the outage it is', async () => {
      // Inside an _msearch a failed search is an item of a 200 answer rather
      // than a thrown 503, and read as any other failure it would hide the
      // outage banner and skip the fail-fast window
      mockClient.msearch.mockResolvedValue({
        took: 0,
        responses: [{ status: 503, error: { type: 'search_phase_execution_exception', reason: 'all shards failed' } }],
      });

      const error = await searchVideos('q').catch((caught: unknown) => caught);

      expect(isElasticsearchUnavailable(error)).toBe(true);
      expect(String(error)).toContain('503 search_phase_execution_exception: all shards failed');
    });

    it('fails a search the cluster refused with its reason and root cause in the message', async () => {
      mockClient.msearch.mockResolvedValue({
        took: 0,
        responses: [
          {
            status: 400,
            error: {
              type: 'search_phase_execution_exception',
              root_cause: [{ type: 'illegal_argument_exception', reason: 'Result window is too large' }],
            },
          },
        ],
      });

      const error = await searchVideos('q').catch((caught: unknown) => caught);

      expect(isElasticsearchUnavailable(error)).toBe(false);
      expect(String(error)).toContain(
        'Elasticsearch refused the search: 400 search_phase_execution_exception: no reason given ' +
          '(illegal_argument_exception: Result window is too large)',
      );
    });

    it('fails a multi-search answer that carries no response', async () => {
      mockClient.msearch.mockResolvedValue({ took: 0, responses: [] });

      await expect(searchVideos('q')).rejects.toThrow('Elasticsearch answered the search without a response');
    });

    it('narrows the search to the given folders', async () => {
      await searchVideos('q', 'date-desc', [FOLDER_B]);

      expect(sentSearch().header.index).toEqual([ALIAS_B]);
    });

    it('returns nothing without querying when no folder qualifies', async () => {
      // An empty index list would make Elasticsearch search *every* index
      expect(await searchVideos('q', 'date-desc', [])).toEqual([]);
      expect(mockClient.msearch).not.toHaveBeenCalled();
    });

    it('passes offset and limit through to Elasticsearch', async () => {
      await searchVideos('q', 'date-desc', undefined, { offset: 200, limit: 25 });

      const request = sentSearch().body;
      expect(request.from).toBe(200);
      expect(request.size).toBe(25);
    });

    it('shortens a page whose end would cross the result window', async () => {
      // 10000 is Elasticsearch's default index.max_result_window: a request
      // with from + size above it is rejected, so the page is cut at the end.
      await searchVideos('q', 'date-desc', undefined, { offset: 9990, limit: 20 });

      const request = sentSearch().body;
      expect(request.from).toBe(9990);
      expect(request.size).toBe(10);
    });

    it('leaves a page that ends exactly at the result window untouched', async () => {
      await searchVideos('q', 'date-desc', undefined, { offset: 9900, limit: 100 });

      const request = sentSearch().body;
      expect(request.from).toBe(9900);
      expect(request.size).toBe(100);
    });

    it('answers an offset past the result window with a count-only page', async () => {
      answerSearch({ hits: { total: { value: 37438, relation: 'eq' }, hits: [] } });

      const result = await searchVideosWithTotal('q', 'date-desc', undefined, { offset: 10_000, limit: 20 });

      // Asking for hits there would 400; a size-0 query at the start keeps the
      // total honest and returns no page to repeat.
      const request = sentSearch().body;
      expect(request.from).toBe(0);
      expect(request.size).toBe(0);
      expect(result.videos).toEqual([]);
      expect(result.total).toBe(37438);
    });

    it('filters by channel', async () => {
      await searchVideos('q', 'date-desc', undefined, {
        channel: 'Jordan B Peterson',
      });

      const request = sentSearch().body;
      expect(request.query).toEqual({
        bool: {
          must: [phraseQuery('q')],
          filter: [{ term: { 'channelName.keyword': 'Jordan B Peterson' } }],
        },
      });
    });

    it('applies filters to blank queries too', async () => {
      await searchVideos(undefined, 'date-desc', undefined, { channel: 'X' });

      const request = sentSearch().body;
      expect(request.query).toEqual({
        bool: { must: [{ match_all: {} }], filter: [{ term: { 'channelName.keyword': 'X' } }] },
      });
    });

    it('looks a pasted link up by its video id, keeping the filter, sort and paging, without highlights', async () => {
      await searchVideosWithTotal(
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLx&index=3',
        'date-desc',
        undefined,
        {
          channel: 'X',
          offset: 0,
          limit: 10,
        },
      );

      const { header, body } = sentSearch();
      expect(body.query).toEqual({
        bool: { must: [{ ids: { values: ['dQw4w9WgXcQ'] } }], filter: [{ term: { 'channelName.keyword': 'X' } }] },
      });
      expect(body.sort).toEqual([{ uploadDate: { order: 'desc', missing: '_last' } }]);
      expect(body.size).toBe(10);
      expect(body).not.toHaveProperty('highlight');
      expect(header).not.toHaveProperty('search_type');
      // A link names one video: no text search follows, even when it is not archived
      expect(mockClient.msearch).toHaveBeenCalledTimes(1);
    });

    it('answers a bare video id from the id lookup when a video has it', async () => {
      answerSearch({ hits: { total: { value: 1, relation: 'eq' }, hits: [hit(toDocument(video()), 'dQw4w9WgXcQ')] } });

      const result = await searchVideosWithTotal('dQw4w9WgXcQ');

      expect(sentSearch().body.query).toEqual({ ids: { values: ['dQw4w9WgXcQ'] } });
      expect(result.total).toBe(1);
      expect(mockClient.msearch).toHaveBeenCalledTimes(1);
    });

    it('searches an eleven-character word as text when no video has it as its id', async () => {
      answerSearch({ hits: { total: { value: 0, relation: 'eq' }, hits: [] } });

      await searchVideosWithTotal('programming');

      expect(mockClient.msearch).toHaveBeenCalledTimes(2);
      expect(sentSearch(0).body.query).toEqual({ ids: { values: ['programming'] } });
      expect(sentSearch(1).body.query).toEqual(phraseQuery('programming'));
      expect(sentSearch(1).body.highlight).toBeDefined();
    });

    it('maps ES highlight fragments into the response contract', async () => {
      answerSearch({
        hits: {
          hits: [
            {
              _id: 'id',
              _source: { ...toDocument(video()) },
              highlight: {
                title: ['a \u0001robot\u0002 arm'],
                description: ['desc \u0001robot\u0002 here'],
                commentsText: ['comment \u0001robot\u0002!'],
              },
            },
          ],
        },
      });

      const results = await searchVideos('robot');

      expect(at(results, 0).highlights).toEqual({
        title: ['a \u0001robot\u0002 arm'],
        description: ['desc \u0001robot\u0002 here'],
        snippet: ['comment \u0001robot\u0002!'],
      });
    });

    it('requests highlight fragments only for real queries', async () => {
      await searchVideos('robot');
      const first = sentSearch().body;
      expect(first.highlight).toBeDefined();
      expect(first.highlight?.pre_tags).toEqual(['\u0001']);
      expect(first.highlight?.post_tags).toEqual(['\u0002']);

      await searchVideos('   ');
      expect(sentSearch(1).body.highlight).toBeUndefined();
    });

    it('hands the abort signal to the transport, and no transport options without one', async () => {
      const controller = new AbortController();

      await searchVideosWithTotal('robot', 'date-desc', undefined, { signal: controller.signal });
      await searchVideosWithTotal('robot');

      // The transport drops the connection on abort, which is what makes the
      // cluster cancel the search; the signal never leaks into the request
      expect(at(mockClient.msearch.mock.calls, 0)[1]).toEqual({ signal: controller.signal });
      expect(sentSearch(0).body).not.toHaveProperty('signal');
      expect(at(mockClient.msearch.mock.calls, 1)[1]).toBeUndefined();
    });

    it('caps what the highlighter analyzes', async () => {
      await searchVideos('robot');

      const { body } = sentSearch();
      // At or below the index's own limit (index.highlight.max_analyzed_offset,
      // 1,000,000 by default) a long field is truncated instead of failing the
      // fetch of its folder's shard
      expect(body.highlight.max_analyzed_offset).toBe(HIGHLIGHT_MAX_ANALYZED_CHARS);
      expect(HIGHLIGHT_MAX_ANALYZED_CHARS).toBeLessThanOrEqual(1_000_000);
    });

    it('serves a page without the folder that could not answer, and logs which one', async () => {
      // A red index, a shard still recovering after a restart, or the old
      // version a reindex deletes right after its swap: refusing the page would
      // show the outage banner for the whole library while the cluster answers
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {
        /* the warning is the assertion */
      });
      answerSearch({
        _shards: {
          total: 2,
          successful: 1,
          skipped: 0,
          failed: 1,
          failures: [
            {
              index: 'videos_b_20250101000000000',
              shard: 0,
              reason: { type: 'no_shard_available_action_exception', reason: 'no shard copy is active' },
            },
          ],
        },
        hits: { hits: [hit(toDocument(video()))], total: { value: 1, relation: 'eq' } },
      });

      const results = await searchVideos('robot');

      expect(results).toHaveLength(1);
      expect(sentSearch().header).not.toHaveProperty('allow_partial_search_results');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('without 1 of 2 folder shards'));
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('videos_b_20250101000000000: no_shard_available_action_exception'),
      );
    });

    it('lists every channel name each folder carries, most frequent first', async () => {
      answerSearch({
        aggregations: {
          folders: {
            buckets: [
              { key: '/videos/b', channel: { buckets: [{ key: 'Beta' }, { key: 'Beta (old)' }] } },
              { key: '/videos/a', channel: { buckets: [{ key: 'Alpha' }] } },
              { key: '/videos/unlabelled', channel: { buckets: [] } },
            ],
          },
        },
      });

      expect(await listChannelsByFolder()).toEqual({
        // A folder whose videos carry no channel name is left out, so the
        // console can hide the search link instead of pointing nowhere
        '/videos/a': ['Alpha'],
        '/videos/b': ['Beta', 'Beta (old)'],
      });

      // One query answers for every folder, and it asks for the field the
      // mapping declares: folderPath is a keyword, folderPath.keyword is
      // nothing at all, and the missing field is why the map used to be empty
      const request = sentSearch().body;
      expect(request.aggs).toEqual({
        folders: {
          terms: { field: 'folderPath', size: 500 },
          aggs: { channel: { terms: { field: 'channelName.keyword', size: 10 } } },
        },
      });
    });

    it('answers with no folders while a configured one has no index yet', async () => {
      // A freshly attached drive adds folders that nobody has indexed. Search
      // already tolerates their missing aliases; the channel filter must too,
      // otherwise the whole endpoint answers 500 until the drive is indexed.
      answerSearch({ aggregations: { folders: { buckets: [] } } });

      expect(await listChannelsByFolder()).toEqual({});

      expect(sentSearch().header).toEqual({ index: [ALIAS_A, ALIAS_B], ignore_unavailable: true });
    });

    it('clamps out-of-range paging values', async () => {
      await searchVideos('q', 'date-desc', undefined, { offset: -10, limit: 9999 });

      const request = sentSearch().body;
      expect(request.from).toBe(0);
      expect(request.size).toBe(500);
    });
  });

  describe('single-document lookups', () => {
    beforeEach(() => {
      answerSearch({ hits: { hits: [] } });
    });

    it('getVideoByVideoId uses an ids query and returns null when missing', async () => {
      expect(await getVideoByVideoId('abc')).toBeNull();
      const { header, body } = sentSearch();
      expect(body.query).toEqual({ ids: { values: ['abc'] } });
      expect(body.size).toBe(1);
      expect(header).toEqual({ index: [ALIAS_A, ALIAS_B], ignore_unavailable: true });
    });

    it('getVideoByBaseName uses a term query', async () => {
      answerSearch({
        hits: { hits: [{ _id: 'x', _source: toDocument(video()) }] },
      });

      const found = await getVideoByBaseName('20240101_Video');

      expect(found?.baseName).toBe('20240101_Video');
      expect(found?.comments).toBeUndefined();
      expect(sentSearch().body.query).toEqual({
        term: { baseName: '20240101_Video' },
      });
    });

    it('getVideoByFilePath matches video or thumbnail file names', async () => {
      await getVideoByFilePath('a.mp4');

      expect(sentSearch().body.query).toEqual({
        bool: {
          should: [{ term: { videoPath: 'a.mp4' } }, { term: { thumbnailPath: 'a.mp4' } }],
          minimum_should_match: 1,
        },
      });
    });
  });
});
