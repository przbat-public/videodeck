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
  toDocument,
} from './elasticsearchService';

/**
 * Real-Elasticsearch tests for the alias-swap reindex flow and the Polish
 * analyzer. Skipped by default — run against a live cluster with:
 *
 *   RUN_ES_INTEGRATION=1 npx jest src/services/elasticsearch.integration.test.ts
 *
 * A scratch folder path keeps the tests away from the aliases of the real
 * configured folders; everything is deleted after each test.
 */

const runIntegration = process.env.RUN_ES_INTEGRATION === '1';
const describeIntegration = runIntegration ? describe : describe.skip;

const SCRATCH_FOLDER = '/integration-scratch-folder';

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
});

/** Flatten videos into the stored document shape */
function documentsOf(videos: VideoListItem[]) {
  return videos.map(toDocument);
}
