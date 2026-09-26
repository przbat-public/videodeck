import { Client } from '@elastic/elasticsearch';
import type { VideoListItem } from '@videodeck/shared/api';
import { ELASTICSEARCH_URL } from '../config';
import {
  bulkIndexDocuments,
  createIndexVersion,
  deleteIndex,
  getIndexVersions,
  promoteIndexVersion,
  searchVideos,
  searchVideosWithTotal,
  toDocument,
} from './elasticsearchService';

/**
 * Real-Elasticsearch tests: the contract twins of the scenarios the fake
 * pins in `server/src/test/fakeElasticsearch.test.ts` (whose header carries
 * the fake's fidelity note), plus the alias-swap reindex flow and the Polish
 * analyzer. The two suites assert the same scenarios, so a fake that drifts
 * from the cluster fails one of them.
 *
 * Skipped by default — run against a live cluster with:
 *
 *   cd server && pnpm run test:integration
 *   cd server && pnpm run test:integration -t "reports errors: true"
 *
 * (pnpm 12 forwards a `--` separator literally, so the filter goes straight
 * after the script name.) A scratch folder path keeps the tests away from the
 * aliases of the real configured folders; everything is deleted after each
 * test.
 */

const runIntegration = process.env.RUN_ES_INTEGRATION === '1';
const describeIntegration = runIntegration ? describe : describe.skip;

const SCRATCH_FOLDER = '/integration-scratch-folder';

/**
 * A count past int32. A digit string survives `toDocument`'s coercion as this
 * number, so a hand-edited info.json puts it on the wire, and the `integer`
 * mapping refuses it.
 */
const OUT_OF_RANGE_VIEW_COUNT = 100_000_000_000_000_000_000;

/** The error body a real cluster answers a refused page with */
interface SearchErrorBody {
  error: {
    type: string;
    reason: string;
    root_cause: Array<{ type: string; reason: string }>;
    failed_shards: Array<{ reason: { type: string } }>;
  };
  status: number;
}

function video(baseName: string, title: string): VideoListItem {
  return {
    baseName,
    title,
    description: 'Integration test document',
    videoPath: `${baseName}.mp4`,
    thumbnailPath: `${baseName}.webp`,
    folderPath: SCRATCH_FOLDER,
    comments: [],
  };
}

describeIntegration('Elasticsearch integration', () => {
  const esClient = new Client({ node: ELASTICSEARCH_URL });

  beforeAll(async () => {
    await esClient.ping();
  });

  afterEach(async () => {
    await deleteIndex(SCRATCH_FOLDER);
  });

  /**
   * The error a raw search throws, as the cluster answered it. Only the raw
   * client can ask for a page past the result window: the service clamps its
   * own paging before the request leaves.
   */
  async function searchFailure(
    index: string,
    from: number,
    size: number,
  ): Promise<{ status: number; body: SearchErrorBody }> {
    try {
      await esClient.search({ index, query: { match_all: {} }, from, size });
    } catch (error) {
      const failure = error as { meta?: { statusCode?: number }; body?: SearchErrorBody };
      if (failure.meta?.statusCode !== undefined && failure.body !== undefined) {
        return { status: failure.meta.statusCode, body: failure.body };
      }
      throw error;
    }
    throw new Error(`the cluster served from=${from} size=${size} instead of refusing the page`);
  }

  /** One document behind the folder alias, so a search really has an index */
  async function indexOneVideo(baseName: string, title: string): Promise<string> {
    const indexName = await createIndexVersion(SCRATCH_FOLDER);
    await bulkIndexDocuments(indexName, documentsOf([video(baseName, title)]), false);
    await promoteIndexVersion(SCRATCH_FOLDER, indexName);
    return indexName;
  }

  it('finds Polish text with folded diacritics', async () => {
    const indexName = await createIndexVersion(SCRATCH_FOLDER);
    await bulkIndexDocuments(indexName, [toDocument(video('20240101_czyszczenie', 'Czyścimy środek kadru'))], false);
    await promoteIndexVersion(SCRATCH_FOLDER, indexName);

    // No diacritics in the query — asciifolding makes it match
    const folded = await searchVideos('srodek', 'date-desc', [SCRATCH_FOLDER]);
    expect(folded.map((item) => item.baseName)).toContain('20240101_czyszczenie');
  });

  it('finds videos by their transcript and never returns the transcript itself', async () => {
    const indexName = await createIndexVersion(SCRATCH_FOLDER);
    await bulkIndexDocuments(
      indexName,
      [toDocument(video('20240101_wyklad', 'Wykład o historii'))].map((document) => ({
        ...document,
        transcriptText: 'mówimy tutaj o bitwie pod Grunwaldem i jej skutkach',
      })),
      false,
    );
    await promoteIndexVersion(SCRATCH_FOLDER, indexName);

    const results = await searchVideos('grunwaldem', 'relevance', [SCRATCH_FOLDER]);
    expect(results).toHaveLength(1);
    expect(results[0]?.baseName).toBe('20240101_wyklad');
    expect(results[0]).not.toHaveProperty('transcriptText');
  });

  it('swaps the alias atomically and serves only the new index version', async () => {
    const v1 = await createIndexVersion(SCRATCH_FOLDER);
    await bulkIndexDocuments(v1, documentsOf([video('20240101_old', 'Old')]), false);
    await promoteIndexVersion(SCRATCH_FOLDER, v1);
    expect(await getIndexVersions(SCRATCH_FOLDER)).toEqual([v1]);

    const v2 = await createIndexVersion(SCRATCH_FOLDER);
    await bulkIndexDocuments(v2, documentsOf([video('20240202_new', 'New')]), false);
    await promoteIndexVersion(SCRATCH_FOLDER, v2);

    expect(await getIndexVersions(SCRATCH_FOLDER)).toEqual([v2]);
    const results = await searchVideos('', 'date-desc', [SCRATCH_FOLDER]);
    expect(results.map((item) => item.baseName)).toEqual(['20240202_new']);
  });

  it('leaves the previous index untouched when the new version is never promoted', async () => {
    const v1 = await createIndexVersion(SCRATCH_FOLDER);
    await bulkIndexDocuments(v1, documentsOf([video('20240101_kept', 'Kept')]), false);
    await promoteIndexVersion(SCRATCH_FOLDER, v1);

    // A failed reindex discards its version; the alias still points at v1
    const v2 = await createIndexVersion(SCRATCH_FOLDER);
    await esClient.indices.delete({ index: v2 });

    expect(await getIndexVersions(SCRATCH_FOLDER)).toEqual([v1]);
    const results = await searchVideos('', 'date-desc', [SCRATCH_FOLDER]);
    expect(results.map((item) => item.baseName)).toEqual(['20240101_kept']);
  });

  // The three scenarios below are the twins of the fake's own tests: the same
  // scenario name, the same expectation, once against the fake and once here.

  it('refuses a page past the result window the way Elasticsearch does', async () => {
    const indexName = await indexOneVideo('20240101_okno', 'Okno wyników');

    // from + size = 10010 crosses index.max_result_window (10000 by default)
    const failure = await searchFailure(indexName, 9990, 20);

    expect(failure.status).toBe(400);
    expect(failure.body.error.type).toBe('search_phase_execution_exception');
    expect(failure.body.error.reason).toBe('all shards failed');
    expect(failure.body.error.root_cause[0]?.type).toBe('illegal_argument_exception');
    expect(failure.body.error.root_cause[0]?.reason).toContain('Result window is too large');
    expect(failure.body.error.root_cause[0]?.reason).toContain('[10000] but was [10010]');
    expect(failure.body.error.failed_shards[0]?.reason.type).toBe('illegal_argument_exception');
    expect(failure.body.status).toBe(400);

    // The clamped page the service sends instead is served, total included,
    // so a deep page cannot reach the user as a 500
    const page = await searchVideosWithTotal('', 'date-desc', [SCRATCH_FOLDER], { offset: 9990, limit: 20 });
    expect(page.videos).toEqual([]);
    expect(page.total).toBe(1);
  });

  it('still serves a page that ends exactly at the result window', async () => {
    const indexName = await indexOneVideo('20240101_okno', 'Okno wyników');

    // from + size = 10000 sits on the limit, which the refusal is inclusive of
    const response = await esClient.search({ index: indexName, query: { match_all: {} }, from: 9900, size: 100 });

    expect(response.hits.total).toEqual({ value: 1, relation: 'eq' });
    expect(response.hits.hits).toEqual([]);
  });

  it('reports errors: true when any bulk item failed', async () => {
    const indexName = await createIndexVersion(SCRATCH_FOLDER);
    const documents = [
      toDocument(video('20240101_dobry', 'Dobry film')),
      { ...toDocument(video('20240101_ogromny', 'Ogromne wyswietlenia')), viewCount: OUT_OF_RANGE_VIEW_COUNT },
    ];

    const response = await esClient.bulk({
      operations: documents.flatMap((document) => [
        { index: { _index: indexName, _id: document.videoId || document.baseName } },
        document,
      ]),
    });

    expect(response.errors).toBe(true);
    expect(response.items[0]?.index?.status).toBe(201);
    expect(response.items[1]?.index?.status).toBeGreaterThanOrEqual(400);
    expect(response.items[1]?.index?.error?.type).toBe('document_parsing_exception');

    // The caller's side of the same scenario: the refused document is counted
    // as skipped, never as indexed, and the batch still lands
    const outcome = await bulkIndexDocuments(indexName, documents, false);
    expect(outcome).toEqual({ indexed: 1, skipped: 1 });

    await promoteIndexVersion(SCRATCH_FOLDER, indexName);
    const results = await searchVideos('', 'date-desc', [SCRATCH_FOLDER]);
    expect(results.map((item) => item.baseName)).toEqual(['20240101_dobry']);
  });
});

/** Flatten videos into the stored document shape */
function documentsOf(videos: VideoListItem[]) {
  return videos.map(toDocument);
}
