import {
  buildIndexVersionName,
  bulkIndexDocuments,
  bulkIndexVideos,
  checkElasticsearchConnection,
  createIndex,
  createIndexVersion,
  deleteIndex,
  discardIndexVersion,
  estimateDocumentBytes,
  fromDocument,
  getIndexNameFromFolderPath,
  getIndexVersions,
  getTotalVideoCount,
  getVideoByBaseName,
  getVideoByFilePath,
  getVideoByVideoId,
  indexVideo,
  promoteIndexVersion,
  recreateIndex,
  SEARCH_FIELDS,
  searchVideos,
  toDocument,
} from './elasticsearchService';
import type { VideoListItem } from '@shared/api';
import { at } from '../test-utils';

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
};

jest.mock('@elastic/elasticsearch', () => ({
  Client: jest.fn(() => mockClient),
}));

const FOLDER_A = '/videos/a';
const FOLDER_B = '/videos/b';

jest.mock('../config', () => ({
  ELASTICSEARCH_URL: 'http://localhost:9200',
  getVideosFolderPaths: () => ['/videos/a', '/videos/b'],
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
  mockClient.indices.getAlias.mockResolvedValue(
    Object.fromEntries(indices.map((index) => [index, { aliases: {} }]))
  );
  physicalIndices(...indices);
}

/** What `indices.get('<alias>_*')` returns */
function physicalIndices(...indices: string[]) {
  mockClient.indices.get.mockResolvedValue(
    Object.fromEntries(indices.map((index) => [index, { aliases: {} }]))
  );
}

describe('elasticsearchService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});

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
        })
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
      expect(item.comments).toEqual([]);
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
        analyzer: 'standard',
      });
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
      expect(mockClient.indices.delete).not.toHaveBeenCalledWith(
        expect.objectContaining({ index: ALIAS_A })
      );
    });

    it('sweeps orphaned versions left by a crashed reindex', async () => {
      aliasPointsAt(`${ALIAS_A}_old`);
      physicalIndices(`${ALIAS_A}_old`, `${ALIAS_A}_orphan`, `${ALIAS_A}_new`);

      await promoteIndexVersion(FOLDER_A, `${ALIAS_A}_new`);

      expect(mockClient.indices.get).toHaveBeenCalledWith(
        expect.objectContaining({ index: `${ALIAS_A}_*`, ignore_unavailable: true })
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
      const targets = mockClient.bulk.mock.calls
        .map(([req]) => req.operations[0].index._index)
        .sort();
      expect(targets).toEqual([ALIAS_A, ALIAS_B].sort());
      expect(mockClient.indices.refresh).toHaveBeenCalledWith({ index: ALIAS_A });
      expect(mockClient.indices.refresh).toHaveBeenCalledWith({ index: ALIAS_B });
    });

    it('does nothing for an empty list', async () => {
      await bulkIndexVideos([]);
      expect(mockClient.bulk).not.toHaveBeenCalled();
    });

    it('throws when the bulk response reports item errors', async () => {
      mockClient.bulk.mockResolvedValue({
        errors: true,
        items: [
          { index: { _id: 'a', status: 201 } },
          { index: { _id: 'b', status: 400, error: { reason: 'mapper_parsing_exception' } } },
        ],
      });

      await expect(
        bulkIndexVideos([video({ videoId: 'a' }), video({ videoId: 'b' })], { index: 'x' })
      ).rejects.toThrow('Bulk indexing failed for 1 of 2 videos');
    });
  });

  describe('bulkIndexDocuments', () => {
    it('writes the documents as-is with videoId (or baseName) as id', async () => {
      await bulkIndexDocuments(
        'videos_target',
        [toDocument(video({ videoId: 'a' })), toDocument(videoWithoutId({ baseName: 'nb' }))],
        false
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
      const big = estimateDocumentBytes(
        toDocument(video({ comments: [{ id: '1', text: 'x'.repeat(10_000) }] }))
      );
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
      expect(request.sort).toEqual([{ viewCount: { order: 'desc', missing: '_last' } }]);
      expect(request.size).toBe(100);
      expect(request._source).toEqual({ excludes: ['commentsText'] });

      expect(results).toHaveLength(1);
      expect(at(results, 0)).not.toHaveProperty('commentsText');
      expect(at(results, 0).comments).toEqual([]);
    });

    it('uses match_all for blank queries and sorts by date by default', async () => {
      await searchVideos('   ');

      const request = mockClient.search.mock.calls[0][0];
      expect(request.query).toEqual({ match_all: {} });
      expect(request.sort).toEqual([{ uploadDate: { order: 'desc', missing: '_last' } }]);
    });

    it('fails loudly on hits without _source', async () => {
      mockClient.search.mockResolvedValue({ hits: { hits: [{ _id: 'x' }] } });
      await expect(searchVideos('q')).rejects.toThrow('has no _source');
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
      expect(found?.comments).toEqual([]);
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

  describe('misc', () => {
    it('getTotalVideoCount counts across aliases', async () => {
      mockClient.count.mockResolvedValue({ count: 42 });

      expect(await getTotalVideoCount()).toBe(42);
      expect(mockClient.count).toHaveBeenCalledWith({
        index: [ALIAS_A, ALIAS_B],
        ignore_unavailable: true,
        query: { match_all: {} },
      });
    });

    it('checkElasticsearchConnection reflects ping', async () => {
      mockClient.ping.mockResolvedValue(true);
      expect(await checkElasticsearchConnection()).toBe(true);

      mockClient.ping.mockRejectedValue(new Error('down'));
      expect(await checkElasticsearchConnection()).toBe(false);
    });
  });
});
