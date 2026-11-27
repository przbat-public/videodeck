import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@elastic/elasticsearch';
import type { VideoListItem } from '@videodeck/shared/api';
import { ELASTICSEARCH_URL, invalidateVideosFolderCache } from '../config';
import {
  bulkIndexDocuments,
  createIndexVersion,
  deleteAllVideosFromFolder,
  deleteIndex,
  getIndexNameFromFolderPath,
  getIndexVersions,
  getVideoByFilePath,
  listChannelsByFolder,
  promoteIndexVersion,
  SEARCH_FIELDS,
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
/** A second folder, so one search spans two single-shard indices */
const SECOND_SCRATCH_FOLDER = '/integration-scratch-folder-two';

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

/** Alias-shaped names nothing holds, as many as the folders of a large library */
function aliasNames(count: number): string[] {
  return Array.from({ length: count }, (_unused, index) => `videos_${String(index).padStart(16, '0')}`);
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
    await deleteIndex(SECOND_SCRATCH_FOLDER);
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

  /** Status and body of a raw request the cluster refused */
  async function rejectionOf(request: Promise<unknown>): Promise<{ status: number; body: unknown }> {
    try {
      await request;
    } catch (error) {
      const failure = error as { meta?: { statusCode?: number }; body?: unknown };
      if (failure.meta?.statusCode !== undefined) {
        return { status: failure.meta.statusCode, body: failure.body };
      }
      throw error;
    }
    throw new Error('the cluster served a request it was expected to refuse');
  }

  /**
   * The first folder holds a video whose comments run past
   * index.highlight.max_analyzed_offset (1,000,000 characters) next to a light
   * one, the second a light video of its own. Every title holds "film".
   */
  async function seedHighlightFolders(): Promise<{ heavy: string; other: string }> {
    const heavy = await createIndexVersion(SCRATCH_FOLDER);
    await bulkIndexDocuments(
      heavy,
      [
        { ...toDocument(video('20240103_ciezki', 'Film z komentarzami')), commentsText: 'komentarz '.repeat(110_000) },
        toDocument(video('20240101_lekki', 'Film bez komentarzy')),
      ],
      false,
    );
    await promoteIndexVersion(SCRATCH_FOLDER, heavy);
    const other = await createIndexVersion(SECOND_SCRATCH_FOLDER);
    await bulkIndexDocuments(
      other,
      [toDocument({ ...video('20240102_inny', 'Film z innego folderu'), folderPath: SECOND_SCRATCH_FOLDER })],
      false,
    );
    await promoteIndexVersion(SECOND_SCRATCH_FOLDER, other);
    return {
      heavy: getIndexNameFromFolderPath(SCRATCH_FOLDER),
      other: getIndexNameFromFolderPath(SECOND_SCRATCH_FOLDER),
    };
  }

  /** A typed search that highlights the comments, as the service's page search does */
  function highlightBody(maxAnalyzedOffset?: number) {
    return {
      query: { multi_match: { query: 'film', fields: ['title', 'commentsText'] } },
      track_total_hits: true,
      highlight: {
        fields: { commentsText: { fragment_size: 160, number_of_fragments: 1 } },
        ...(maxAnalyzedOffset === undefined ? {} : { max_analyzed_offset: maxAnalyzedOffset }),
      },
    };
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

  it('matches any query term, tolerates a typo and ignores a substring that is not a token', async () => {
    const indexName = await createIndexVersion(SCRATCH_FOLDER);
    await bulkIndexDocuments(
      indexName,
      [toDocument(video('20240101_kosmos', 'Historia kosmosu')), toDocument(video('20240102_rower', 'Rower gorski'))],
      false,
    );
    await promoteIndexVersion(SCRATCH_FOLDER, indexName);

    // best_fields with the default operator: one matching term is enough, which
    // is the scenario the fake pinned as "matches any of the query terms"
    const anyTerm = await searchVideos('kosmos rower', 'date-desc', [SCRATCH_FOLDER]);
    expect(anyTerm.map((item) => item.baseName).sort()).toEqual(['20240101_kosmos', '20240102_rower']);

    // fuzziness AUTO: a five-character term gets one edit, and a transposition
    // is one edit
    const typo = await searchVideos('hitsoria', 'date-desc', [SCRATCH_FOLDER]);
    expect(typo.map((item) => item.baseName)).toEqual(['20240101_kosmos']);

    // The other half of the same rule: the analyzer matches tokens, so a
    // substring two edits beyond the budget does not match, and neither does a
    // three-character prefix of a six-character token
    expect(await searchVideos('toria', 'date-desc', [SCRATCH_FOLDER])).toHaveLength(0);
    expect(await searchVideos('row', 'date-desc', [SCRATCH_FOLDER])).toHaveLength(0);
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

  it('empties a folder through delete_by_query and keeps its index', async () => {
    const indexName = await createIndexVersion(SCRATCH_FOLDER);
    await bulkIndexDocuments(
      indexName,
      documentsOf([video('20240101_pierwszy', 'Pierwszy dokument'), video('20240102_drugi', 'Drugi dokument')]),
      false,
    );
    await promoteIndexVersion(SCRATCH_FOLDER, indexName);

    // The production path behind "delete every video of this folder": the fake
    // used to clear the whole index whatever the query said, so this call was
    // never checked against the cluster.
    await deleteAllVideosFromFolder(SCRATCH_FOLDER);

    expect(await searchVideos('dokument', 'date-desc', [SCRATCH_FOLDER])).toHaveLength(0);
    expect(await getIndexVersions(SCRATCH_FOLDER)).toContain(indexName);
  });

  it('lists the channel of each folder through the field the mapping declares', async () => {
    // The service reads the configured folders, so the test points the
    // configuration at a real directory of its own and reads the answer back
    // from the cluster. `folderPath` is mapped as a keyword, and a cluster
    // answers the `folderPath.keyword` the service used to ask for with no
    // buckets at all, so the folder map came back empty and said nothing.
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'es-channels-'));
    const previous = process.env.VIDEOS_FOLDER_PATH;
    process.env.VIDEOS_FOLDER_PATH = folder;
    invalidateVideosFolderCache();
    try {
      const indexName = await createIndexVersion(folder);
      await bulkIndexDocuments(
        indexName,
        documentsOf([{ ...video('20240101_alfa', 'Film kanału Alfa'), folderPath: folder, channelName: 'Kanał Alfa' }]),
        false,
      );
      await promoteIndexVersion(folder, indexName);

      expect(await listChannelsByFolder()).toEqual({ [folder]: ['Kanał Alfa'] });
    } finally {
      await deleteIndex(folder);
      await fs.rm(folder, { recursive: true, force: true });
      if (previous === undefined) {
        delete process.env.VIDEOS_FOLDER_PATH;
      } else {
        process.env.VIDEOS_FOLDER_PATH = previous;
      }
      invalidateVideosFolderCache();
    }
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

  it('serves every folder of a typed search when one video carries more comment text than the highlighter analyzes', async () => {
    await seedHighlightFolders();

    // The deep suite's scenario on a cluster: the service caps the highlighter,
    // so neither the two-folder page nor the heavy folder alone loses a hit
    const page = await searchVideosWithTotal('film', 'date-desc', [SCRATCH_FOLDER, SECOND_SCRATCH_FOLDER]);
    expect(page.total).toBe(3);
    expect(page.videos.map((item) => item.baseName).sort()).toEqual([
      '20240101_lekki',
      '20240102_inny',
      '20240103_ciezki',
    ]);

    const single = await searchVideosWithTotal('film', 'date-desc', [SCRATCH_FOLDER]);
    expect(single.videos.map((item) => item.baseName).sort()).toEqual(['20240101_lekki', '20240103_ciezki']);
  });

  it('ranks the video a typed phrase names above a newer one sharing a word in a comment', async () => {
    const indexName = await createIndexVersion(SCRATCH_FOLDER);
    await bulkIndexDocuments(
      indexName,
      [
        // Newer, and tied to the phrase by one common word in its one comment
        {
          ...toDocument({ ...video('20240105_vlog', 'Vlog z wakacji'), uploadDate: '20240105' }),
          commentsText: 'jak zawsze super',
        },
        toDocument({ ...video('20230101_pizza', 'Jak zrobić pizzę w domu'), uploadDate: '20230101' }),
      ],
      false,
    );
    await promoteIndexVersion(SCRATCH_FOLDER, indexName);

    // No sort asked for: the phrase ranks by relevance, where newest first led
    // with the vlog
    const page = await searchVideosWithTotal('jak zrobić', undefined, [SCRATCH_FOLDER]);
    expect(page.videos.map((item) => item.baseName)).toEqual(['20230101_pizza', '20240105_vlog']);
  });

  it('ranks a title match above a comment match across folders by the statistics of the whole library', async () => {
    // One folder holds one video whose title has the word, the other ten
    // commented videos, one of which has it in a comment. Scored per shard,
    // the word is in every document of the first folder and weighs next to
    // nothing there, while it is rare in the second: the comment led. Over the
    // statistics of both folders (dfs_query_then_fetch) the title match wins.
    const titled = await createIndexVersion(SCRATCH_FOLDER);
    await bulkIndexDocuments(titled, [toDocument(video('20240101_tytul', 'Rakieta na Marsa'))], false);
    await promoteIndexVersion(SCRATCH_FOLDER, titled);

    const commented = await createIndexVersion(SECOND_SCRATCH_FOLDER);
    await bulkIndexDocuments(
      commented,
      Array.from({ length: 10 }, (_unused, index) => ({
        ...toDocument({ ...video(`20240102_film_${index}`, `Odcinek ${index}`), folderPath: SECOND_SCRATCH_FOLDER }),
        commentsText: index === 0 ? 'rakieta super' : 'super odcinek',
      })),
      false,
    );
    await promoteIndexVersion(SECOND_SCRATCH_FOLDER, commented);

    const page = await searchVideosWithTotal('rakieta', undefined, [SCRATCH_FOLDER, SECOND_SCRATCH_FOLDER]);
    expect(page.videos.map((item) => item.baseName)).toEqual(['20240101_tytul', '20240102_film_0']);
  });

  it('scores a downloaded file and a foreign-named file with the same title alike', async () => {
    const indexName = await createIndexVersion(SCRATCH_FOLDER);
    await bulkIndexDocuments(
      indexName,
      [
        // The stem yt-dlp writes, a single token under the standard tokenizer
        toDocument({ ...video('20240101_Robot_Arm_Build_abc12345678', 'Robot Arm Build'), videoId: 'abc12345678' }),
        // A file named outside the app, whose stem splits into words
        toDocument({ ...video('Robot Arm Build [abc12345679]', 'Robot Arm Build'), videoId: 'abc12345679' }),
      ],
      false,
    );
    await promoteIndexVersion(SCRATCH_FOLDER, indexName);

    // The service's own match over its fields: with the file name among them
    // at ^4, the second file's words lifted it above the first
    const response = await esClient.search({
      index: indexName,
      query: { multi_match: { query: 'robot', fields: SEARCH_FIELDS, type: 'best_fields', fuzziness: 'AUTO' } },
    });
    const scores = response.hits.hits.map((hit) => hit._score);
    expect(scores).toHaveLength(2);
    expect(scores[0]).toBe(scores[1]);
  });

  // The scenarios below are the twins of the fake's own tests: the same
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

  it('finds a video by its video or thumbnail file name, and nothing for a name no video holds', async () => {
    // getVideoByFilePath searches every configured folder, so the configuration
    // points at a directory of this test's own, as the channel test does
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'es-files-'));
    const previous = process.env.VIDEOS_FOLDER_PATH;
    process.env.VIDEOS_FOLDER_PATH = folder;
    invalidateVideosFolderCache();
    try {
      const indexName = await createIndexVersion(folder);
      await bulkIndexDocuments(
        indexName,
        documentsOf([
          { ...video('20240101_plik_a', 'Plik A'), folderPath: folder },
          { ...video('20240102_plik_b', 'Plik B'), folderPath: folder },
        ]),
        false,
      );
      await promoteIndexVersion(folder, indexName);

      // One lookup per file kind, plus a name no video holds, which must come
      // back empty rather than as the first video of the folder
      expect((await getVideoByFilePath('20240102_plik_b.mp4'))?.baseName).toBe('20240102_plik_b');
      expect((await getVideoByFilePath('20240101_plik_a.webp'))?.baseName).toBe('20240101_plik_a');
      expect(await getVideoByFilePath('missing.mp4')).toBeNull();

      // A should list on its own needs one match by default: the fake assumes
      // exactly that for a bool query without minimum_should_match
      const bare = await esClient.search({
        index: indexName,
        query: { bool: { should: [{ term: { videoPath: '20240102_plik_b.mp4' } }] } },
      });
      expect(bare.hits.total).toMatchObject({ value: 1 });
    } finally {
      await deleteIndex(folder);
      await fs.rm(folder, { recursive: true, force: true });
      if (previous === undefined) {
        delete process.env.VIDEOS_FOLDER_PATH;
      } else {
        process.env.VIDEOS_FOLDER_PATH = previous;
      }
      invalidateVideosFolderCache();
    }
  });

  it('refuses a request line past 4 KB the way Elasticsearch does', async () => {
    await indexOneVideo('20240101_linia', 'Długa linia');
    const names = [getIndexNameFromFolderPath(SCRATCH_FOLDER), ...aliasNames(299)];

    // http.max_initial_line_length is 4kb and static: the client encodes the
    // commas of 300 names into about 7.8 KB of URL, refused before any lookup
    const failure = await rejectionOf(esClient.search({ index: names, ignore_unavailable: true }));

    expect(failure.status).toBe(400);
    expect(JSON.stringify(failure.body)).toContain('An HTTP line is larger than 4096 bytes.');

    // The service's read over as many folders sends the list in an _msearch
    // header, so the same library is served
    const unindexed = Array.from({ length: 299 }, (_unused, index) => `${SCRATCH_FOLDER}-unindexed-${index}`);
    const page = await searchVideosWithTotal('', 'date-desc', [SCRATCH_FOLDER, ...unindexed]);
    expect(page.videos.map((item) => item.baseName)).toEqual(['20240101_linia']);
    expect(page.total).toBe(1);
  });

  it('answers _msearch with one response per search', async () => {
    await indexOneVideo('20240101_wielokrotne', 'Wielokrotne');
    const alias = getIndexNameFromFolderPath(SCRATCH_FOLDER);

    const response = await esClient.msearch({
      searches: [
        // 300 names, 299 of which nothing holds: ignore_unavailable skips them
        { index: [alias, ...aliasNames(299)], ignore_unavailable: true },
        { query: { match_all: {} } },
        // A page past the result window fails its own search, not the request
        { index: alias, ignore_unavailable: true },
        { query: { match_all: {} }, from: 9990, size: 20 },
      ],
    });

    expect(response.responses).toHaveLength(2);
    const [served, refused] = response.responses;
    expect(served?.status).toBe(200);
    expect(served && 'hits' in served ? served.hits.total : undefined).toEqual({ value: 1, relation: 'eq' });
    expect(refused?.status).toBe(400);
    expect(refused && 'error' in refused ? refused.error.type : undefined).toBe('search_phase_execution_exception');
  });

  it('fails the shard of a hit whose highlighted field passes the analyzed-offset limit, unless the request caps it', async () => {
    const { heavy, other } = await seedHighlightFolders();

    // Both folders: the heavy one's shard fails in the fetch phase, so its two
    // hits count in the total and are missing from the page of a 200 answer
    const partial = await esClient.search({ index: [heavy, other], ...highlightBody() });
    expect(partial._shards).toMatchObject({ total: 2, successful: 1, failed: 1 });
    expect(JSON.stringify(partial._shards.failures)).toContain('max_analyzed_offset');
    expect(partial.hits.total).toEqual({ value: 3, relation: 'eq' });
    expect(partial.hits.hits.map((hit) => hit._id)).toEqual(['20240102_inny']);

    // The heavy folder alone is one shard, so the same failure fails the search
    const single = await rejectionOf(esClient.search({ index: heavy, ...highlightBody() }));
    expect(single.status).toBe(400);
    expect(single.body).toMatchObject({
      error: { type: 'search_phase_execution_exception', reason: 'all shards failed' },
    });

    // A request cap at or below the index limit truncates the field instead
    const capped = await esClient.search({ index: [heavy, other], ...highlightBody(100_000) });
    expect(capped._shards).toMatchObject({ total: 2, successful: 2, failed: 0 });
    expect(capped.hits.hits.map((hit) => hit._id).sort()).toEqual([
      '20240101_lekki',
      '20240102_inny',
      '20240103_ciezki',
    ]);
  });

  it('refuses a page with a failed shard when partial results are not allowed', async () => {
    const { heavy, other } = await seedHighlightFolders();

    // The short page above becomes a 400 once partial results are refused
    const refused = await rejectionOf(
      esClient.search({ index: [heavy, other], allow_partial_search_results: false, ...highlightBody() }),
    );
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ error: { type: 'search_phase_execution_exception' } });

    // The same flag in an _msearch header fails that search's item instead
    const response = await esClient.msearch({
      searches: [
        { index: [heavy, other], ignore_unavailable: true, allow_partial_search_results: false },
        highlightBody(),
      ],
    });
    const [item] = response.responses;
    expect(item?.status).toBe(400);
    expect(item && 'error' in item ? item.error.type : undefined).toBe('search_phase_execution_exception');
  });

  it('matches nothing for a term on a subfield the mapping does not declare', async () => {
    const indexName = await indexOneVideo('20240101_podpole', 'Podpole');

    const totalFor = async (field: string) =>
      (await esClient.search({ index: indexName, query: { term: { [field]: '20240101_podpole.mp4' } } })).hits.total;

    // videoPath is a keyword with no subfields: the cluster answers a term on
    // the subfield it does not have with no hits, not with an error
    expect(await totalFor('videoPath.keyword')).toEqual({ value: 0, relation: 'eq' });
    expect(await totalFor('videoPath')).toEqual({ value: 1, relation: 'eq' });
  });
});

/** Flatten videos into the stored document shape */
function documentsOf(videos: VideoListItem[]) {
  return videos.map(toDocument);
}
