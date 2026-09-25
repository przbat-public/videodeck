import type { VideoListItem } from '@videodeck/shared/api';
import { metricsRegistry } from '../metricsRegistry';
import { at } from '../test-utils';
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
  indexCacheLogThrottle,
  indexVideo,
  listCachedFolders,
  listChannelNames,
  noteElasticsearchUnavailable,
  promoteIndexVersion,
  recreateAllIndices,
  recreateIndex,
  SEARCH_FIELDS,
  searchVideos,
  searchVideosWithTotal,
  toDocument,
} from './elasticsearchService';

const mockClient = {
  indices: {
    create: jest.fn(),
    get: jest.fn(),
    exists: jest.fn(),
    existsAlias: jest.fn(),
    getAlias: jest.fn(),
    updateAliases: jest.fn(),
    delete: jest.fn(),
    refresh: jest.fn(),
  },
  bulk: jest.fn(),
  index: jest.fn(),
  search: jest.fn(),
  count: jest.fn(),
  ping: jest.fn(),
  deleteByQuery: jest.fn(),
  close: jest.fn().mockResolvedValue(undefined),
};

jest.mock('@elastic/elasticsearch', () => ({
  Client: jest.fn(() => mockClient),
}));

const FOLDER_A = '/videos/a';
const FOLDER_B = '/videos/b';

/** Mutable so individual tests can simulate "no folders configured" */
const mockFolders = { current: ['/videos/a', '/videos/b'] };

jest.mock('../config', () => ({
  ELASTICSEARCH_URL: 'http://localhost:9200',
  getVideosFolderPaths: () => mockFolders.current,
}));

const ALIAS_A = getIndexNameFromFolderPath(FOLDER_A);
const ALIAS_B = getIndexNameFromFolderPath(FOLDER_B);

const notFound = () => Object.assign(new Error('index_not_found'), { meta: { statusCode: 404 } });

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

describe('elasticsearchService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {
      /* silence expected info logs */
    });
    jest.spyOn(console, 'error').mockImplementation(() => {
      /* silence expected error logs */
    });
    mockFolders.current = ['/videos/a', '/videos/b'];

    mockClient.indices.create.mockResolvedValue({ acknowledged: true });
    mockClient.indices.exists.mockResolvedValue(false);
    mockClient.indices.existsAlias.mockResolvedValue(true);
    mockClient.indices.updateAliases.mockResolvedValue({ acknowledged: true });
    mockClient.indices.delete.mockResolvedValue({ acknowledged: true });
    mockClient.indices.refresh.mockResolvedValue({});
    mockClient.bulk.mockResolvedValue({ errors: false, items: [] });
    mockClient.index.mockResolvedValue({});
    aliasPointsAt();
  });

  afterEach(() => {
    jest.restoreAllMocks();
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
      const request = mockClient.indices.create.mock.calls[0][0];
      expect(request.index).toBe(name);
      expect(request.mappings.properties.commentsText).toEqual({
        type: 'text',
        analyzer: 'polish_folded',
      });
      expect(request.settings.analysis.analyzer.polish_folded.filter).toEqual(['lowercase', 'asciifolding']);
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

  describe('listCachedFolders', () => {
    it('returns the folders whose alias exists (a cache from a previous disk session)', async () => {
      mockClient.indices.existsAlias.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

      const lookup = await listCachedFolders([FOLDER_A, FOLDER_B]);

      expect(lookup.folders).toEqual(new Set([FOLDER_A]));
      expect(lookup.elasticsearchUp).toBe(true);
      expect(mockClient.indices.existsAlias).toHaveBeenCalledWith({ name: ALIAS_A });
      expect(mockClient.indices.existsAlias).toHaveBeenCalledWith({ name: ALIAS_B });
    });

    it('treats a failed alias check as uncached instead of throwing', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {
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
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {
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
      mockClient.search.mockReset();
    });

    it('refuses a read immediately instead of waiting for the client retries', async () => {
      noteElasticsearchUnavailable();

      await expect(searchVideosWithTotal('robot arm')).rejects.toThrow('Elasticsearch is not reachable');
      // The whole point: no request left the process
      expect(mockClient.search).not.toHaveBeenCalled();
    });

    it('lets reads through again once the window has passed', async () => {
      const now = jest.spyOn(Date, 'now');
      now.mockReturnValue(1_000);
      noteElasticsearchUnavailable();
      now.mockReturnValue(10_000);
      mockClient.search.mockResolvedValue({ hits: { hits: [], total: { value: 0 } } });

      await searchVideosWithTotal('robot arm');
      expect(mockClient.search).toHaveBeenCalled();
      now.mockRestore();
    });

    it('lets reads through again after a healthy probe', async () => {
      noteElasticsearchUnavailable();
      mockClient.ping.mockResolvedValue({});
      await checkElasticsearchConnection();
      mockClient.search.mockResolvedValue({ hits: { hits: [], total: { value: 0 } } });

      await searchVideosWithTotal('robot arm');
      expect(mockClient.search).toHaveBeenCalled();
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
      const { Client } = jest.requireMock('@elastic/elasticsearch') as { Client: jest.Mock };
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
      const { Client } = jest.requireMock('@elastic/elasticsearch') as { Client: jest.Mock };
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
      const created = mockClient.indices.create.mock.calls[0][0].index;
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
      expect(mockClient.index.mock.calls[0][0].document).not.toHaveProperty('comments');
    });

    it('falls back to baseName as id', async () => {
      await indexVideo(videoWithoutId());
      expect(mockClient.index.mock.calls[0][0].id).toBe('20240101_Video');
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
      const { operations } = mockClient.bulk.mock.calls[0][0];
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

      const { operations } = mockClient.bulk.mock.calls[0][0];
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
      mockClient.search.mockResolvedValue({ hits: { hits: [] } });
    });

    it('searches all folder aliases with commentsText in the fields and out of the payload', async () => {
      mockClient.search.mockResolvedValue({
        hits: { hits: [hit({ ...toDocument(video()), commentsText: 'leak' })] },
      });

      const results = await searchVideos('robot arm', 'views-desc');

      const request = mockClient.search.mock.calls[0][0];
      expect(request.index).toEqual([ALIAS_A, ALIAS_B]);
      expect(request.ignore_unavailable).toBe(true);
      expect(request.query).toEqual({
        multi_match: {
          query: 'robot arm',
          fields: SEARCH_FIELDS,
          type: 'best_fields',
          fuzziness: 'AUTO',
        },
      });
      expect(SEARCH_FIELDS).toContain('commentsText');
      expect(SEARCH_FIELDS[0]).toBe('baseName.text^4');
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
      mockClient.search.mockResolvedValue({
        hits: {
          total: { value: 3, relation: 'eq' },
          hits: [hit(toDocument(video()), 'a'), hit(toDocument(video()), 'b'), hit(toDocument(video()), 'c')],
        },
      });

      const result = await searchVideosWithTotal('robot arm');

      expect(result.total).toBe(3);
      expect(result.videos).toHaveLength(3);
      expect(mockClient.search.mock.calls[0][0].track_total_hits).toBe(true);
    });

    it('uses match_all for blank queries and sorts by date by default', async () => {
      await searchVideos('   ');

      const request = mockClient.search.mock.calls[0][0];
      expect(request.query).toEqual({ match_all: {} });
      expect(request.sort).toEqual([{ uploadDate: { order: 'desc', missing: '_last' } }]);
    });

    it('refuses to search when no folders are configured (an empty index list would mean all indices)', async () => {
      mockFolders.current = [];

      await expect(searchVideos('q')).rejects.toThrow(/No video folders configured/);
      expect(mockClient.search).not.toHaveBeenCalled();
    });

    it('omits the sort for relevance, letting Elasticsearch order by score', async () => {
      await searchVideos('q', 'relevance');

      const request = mockClient.search.mock.calls[0][0];
      expect(request.sort).toEqual([]);
    });

    it('fails loudly on hits without _source', async () => {
      mockClient.search.mockResolvedValue({ hits: { hits: [{ _id: 'x' }] } });
      await expect(searchVideos('q')).rejects.toThrow('has no _source');
    });

    it('narrows the search to the given folders', async () => {
      await searchVideos('q', 'date-desc', [FOLDER_B]);

      expect(mockClient.search.mock.calls[0][0].index).toEqual([ALIAS_B]);
    });

    it('returns nothing without querying when no folder qualifies', async () => {
      // An empty index list would make Elasticsearch search *every* index
      expect(await searchVideos('q', 'date-desc', [])).toEqual([]);
      expect(mockClient.search).not.toHaveBeenCalled();
    });

    it('passes offset and limit through to Elasticsearch', async () => {
      await searchVideos('q', 'date-desc', undefined, { offset: 200, limit: 25 });

      const request = mockClient.search.mock.calls[0][0];
      expect(request.from).toBe(200);
      expect(request.size).toBe(25);
    });

    it('shortens a page whose end would cross the result window', async () => {
      // 10000 is Elasticsearch's default index.max_result_window: a request
      // with from + size above it is rejected, so the page is cut at the end.
      await searchVideos('q', 'date-desc', undefined, { offset: 9990, limit: 20 });

      const request = mockClient.search.mock.calls[0][0];
      expect(request.from).toBe(9990);
      expect(request.size).toBe(10);
    });

    it('leaves a page that ends exactly at the result window untouched', async () => {
      await searchVideos('q', 'date-desc', undefined, { offset: 9900, limit: 100 });

      const request = mockClient.search.mock.calls[0][0];
      expect(request.from).toBe(9900);
      expect(request.size).toBe(100);
    });

    it('answers an offset past the result window with a count-only page', async () => {
      mockClient.search.mockResolvedValue({ hits: { total: { value: 37438, relation: 'eq' }, hits: [] } });

      const result = await searchVideosWithTotal('q', 'date-desc', undefined, { offset: 10_000, limit: 20 });

      // Asking for hits there would 400; a size-0 query at the start keeps the
      // total honest and returns no page to repeat.
      const request = mockClient.search.mock.calls[0][0];
      expect(request.from).toBe(0);
      expect(request.size).toBe(0);
      expect(result.videos).toEqual([]);
      expect(result.total).toBe(37438);
    });

    it('filters by channel', async () => {
      await searchVideos('q', 'date-desc', undefined, {
        channel: 'Jordan B Peterson',
      });

      const request = mockClient.search.mock.calls[0][0];
      expect(request.query).toEqual({
        bool: {
          must: [expect.objectContaining({ multi_match: expect.objectContaining({ query: 'q' }) })],
          filter: [{ term: { 'channelName.keyword': 'Jordan B Peterson' } }],
        },
      });
    });

    it('applies filters to blank queries too', async () => {
      await searchVideos(undefined, 'date-desc', undefined, { channel: 'X' });

      const request = mockClient.search.mock.calls[0][0];
      expect(request.query).toEqual({
        bool: { must: [{ match_all: {} }], filter: [{ term: { 'channelName.keyword': 'X' } }] },
      });
    });

    it('maps ES highlight fragments into the response contract', async () => {
      mockClient.search.mockResolvedValue({
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
      const first = mockClient.search.mock.calls[0][0];
      expect(first.highlight).toBeDefined();
      expect(first.highlight?.pre_tags).toEqual(['\u0001']);
      expect(first.highlight?.post_tags).toEqual(['\u0002']);

      await searchVideos('   ');
      expect(mockClient.search.mock.calls[1][0].highlight).toBeUndefined();
    });

    it('lists distinct channel names sorted, with the channel of every folder', async () => {
      mockClient.search.mockResolvedValue({
        aggregations: {
          channels: { buckets: [{ key: 'Beta' }, { key: 'Alpha' }] },
          folders: {
            buckets: [
              { key: '/videos/b', channel: { buckets: [{ key: 'Beta' }] } },
              { key: '/videos/a', channel: { buckets: [{ key: 'Alpha' }] } },
              { key: '/videos/unlabelled', channel: { buckets: [] } },
            ],
          },
        },
      });

      expect(await listChannelNames()).toEqual({
        channels: ['Alpha', 'Beta'],
        // A folder whose videos carry no channel name is left out, so the
        // console can hide the search link instead of pointing nowhere
        folders: { '/videos/a': 'Alpha', '/videos/b': 'Beta' },
      });

      // The folder map comes from one query: a sub-aggregation over the terms
      // bucket, so the search page and the console cannot drift apart
      const request = mockClient.search.mock.calls[0][0];
      expect(request.aggs.folders).toEqual({
        terms: { field: 'folderPath.keyword', size: 500 },
        aggs: { channel: { terms: { field: 'channelName.keyword', size: 1 } } },
      });
    });

    it('lists channel names while a configured folder has no index yet', async () => {
      // A freshly attached drive adds folders that nobody has indexed. Search
      // already tolerates their missing aliases; the channel filter must too,
      // otherwise the whole endpoint answers 500 until the drive is indexed.
      mockClient.search.mockResolvedValue({
        aggregations: { channels: { buckets: [{ key: 'Alpha' }] }, folders: { buckets: [] } },
      });

      await listChannelNames();

      const request = mockClient.search.mock.calls[0][0];
      expect(request.index).toEqual([ALIAS_A, ALIAS_B]);
      expect(request.ignore_unavailable).toBe(true);
    });

    it('clamps out-of-range paging values', async () => {
      await searchVideos('q', 'date-desc', undefined, { offset: -10, limit: 9999 });

      const request = mockClient.search.mock.calls[0][0];
      expect(request.from).toBe(0);
      expect(request.size).toBe(500);
    });
  });

  describe('single-document lookups', () => {
    beforeEach(() => {
      mockClient.search.mockResolvedValue({ hits: { hits: [] } });
    });

    it('getVideoByVideoId uses an ids query and returns null when missing', async () => {
      expect(await getVideoByVideoId('abc')).toBeNull();
      const request = mockClient.search.mock.calls[0][0];
      expect(request.query).toEqual({ ids: { values: ['abc'] } });
      expect(request.size).toBe(1);
      expect(request.index).toEqual([ALIAS_A, ALIAS_B]);
    });

    it('getVideoByBaseName uses a term query', async () => {
      mockClient.search.mockResolvedValue({
        hits: { hits: [{ _id: 'x', _source: toDocument(video()) }] },
      });

      const found = await getVideoByBaseName('20240101_Video');

      expect(found?.baseName).toBe('20240101_Video');
      expect(found?.comments).toBeUndefined();
      expect(mockClient.search.mock.calls[0][0].query).toEqual({
        term: { baseName: '20240101_Video' },
      });
    });

    it('getVideoByFilePath matches video or thumbnail file names', async () => {
      await getVideoByFilePath('a.mp4');

      expect(mockClient.search.mock.calls[0][0].query).toEqual({
        bool: {
          should: [{ term: { videoPath: 'a.mp4' } }, { term: { thumbnailPath: 'a.mp4' } }],
          minimum_should_match: 1,
        },
      });
    });
  });
});
