import { createHash } from 'node:crypto';
import type { RecreateIndicesStatus } from '@videodeck/shared/api';
import { getVideosFolderPaths } from '../../config';
import { logger } from '../../utils/logger';
import { LogThrottle } from '../../utils/logThrottle';
import { runPool } from '../../utils/runPool';
import { isElasticsearchUnavailable } from '../elasticsearchErrors';
import { getElasticsearchClient, getProbeClient, noteElasticsearchUnavailable } from './connection';

/**
 * Index layout
 *
 * Every folder is searched through an alias `videos_<hash>` that points at
 * exactly one physical index `videos_<hash>_<timestamp>`. A reindex writes
 * into a brand-new physical index and swaps the alias atomically when it is
 * done, so search keeps working during the (long) scan and a crash half-way
 * leaves the previous index untouched.
 *
 * Comments are stored as one `commentsText` field for full-text search only;
 * the comment tree is read from `.info.json` on demand by the details endpoint.
 */

const INDEX_PREFIX = 'videos';

/**
 * Alias name for a folder (stable, derived from the folder path)
 */
export function getIndexNameFromFolderPath(folderPath: string): string {
  const hash = createHash('sha256').update(folderPath).digest('hex').substring(0, 16);
  return `${INDEX_PREFIX}_${hash}`;
}

/**
 * Name for a new physical index behind the folder alias
 */
export function buildIndexVersionName(folderPath: string, now: Date = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/[-:.TZ]/g, '')
    .slice(0, 17);
  return `${getIndexNameFromFolderPath(folderPath)}_${stamp}`;
}

/**
 * Text analysis for search: diacritics folding, so `srodek` finds `środek`
 * and `ŚRODEK` without the user typing diacritics. Polish stemming/stopwords
 * would need the `analysis-stempel` plugin (not in the stock docker image),
 * so this analyzer sticks to built-in components only; indices created before
 * it existed keep the old `standard` mapping until the next reindex.
 */
const SEARCH_ANALYZER = 'polish_folded';

const INDEX_MAPPINGS = {
  properties: {
    baseName: {
      type: 'keyword',
      fields: {
        // analyzed variant for full-text search (baseName^4 in SEARCH_FIELDS);
        // the keyword parent keeps exact lookups (getVideoByBaseName) working
        text: { type: 'text', analyzer: SEARCH_ANALYZER },
      },
    },
    videoId: { type: 'keyword' },
    title: {
      type: 'text',
      analyzer: SEARCH_ANALYZER,
      fields: {
        keyword: { type: 'keyword' },
      },
    },
    description: {
      type: 'text',
      analyzer: SEARCH_ANALYZER,
    },
    videoPath: { type: 'keyword' },
    thumbnailPath: { type: 'keyword' },
    subtitlePath: { type: 'keyword' },
    folderPath: { type: 'keyword' },
    uploadDate: { type: 'keyword' },
    viewCount: { type: 'integer' },
    likeCount: { type: 'integer' },
    channelName: {
      type: 'text',
      fields: {
        keyword: { type: 'keyword' },
      },
    },
    commentsText: {
      type: 'text',
      analyzer: SEARCH_ANALYZER,
    },
    transcriptText: {
      type: 'text',
      analyzer: SEARCH_ANALYZER,
    },
  },
} as const;

// ---------------------------------------------------------------------------
// Index versions and aliases
// ---------------------------------------------------------------------------

/**
 * Create a fresh, empty physical index for the folder (not yet visible
 * through the alias). Returns its name.
 */
export async function createIndexVersion(folderPath: string): Promise<string> {
  const esClient = getElasticsearchClient();
  const indexName = buildIndexVersionName(folderPath);

  await esClient.indices.create({
    index: indexName,
    settings: {
      index: {
        number_of_replicas: 0,
      },
      analysis: {
        analyzer: {
          [SEARCH_ANALYZER]: {
            type: 'custom',
            tokenizer: 'standard',
            filter: ['lowercase', 'asciifolding'],
          },
        },
      },
    },
    mappings: INDEX_MAPPINGS,
  });

  logger.info(`Index ${indexName} created for folder: ${folderPath}`);
  return indexName;
}

/**
 * Physical indices currently behind the folder alias (empty when none).
 */
export async function getIndexVersions(folderPath: string): Promise<string[]> {
  const esClient = getElasticsearchClient();
  const alias = getIndexNameFromFolderPath(folderPath);
  try {
    const response = await esClient.indices.getAlias({ name: alias });
    return Object.keys(response);
  } catch (error) {
    if ((error as { meta?: { statusCode?: number } }).meta?.statusCode === 404) {
      return [];
    }
    throw error;
  }
}

/**
 * Every physical index created for the folder — behind the alias or orphaned
 * by a reindex that died before promoting/discarding it.
 */
export async function listAllIndexVersions(folderPath: string): Promise<string[]> {
  const esClient = getElasticsearchClient();
  const response = await esClient.indices.get({
    index: `${getIndexNameFromFolderPath(folderPath)}_*`,
    ignore_unavailable: true,
    allow_no_indices: true,
    features: ['aliases'],
  });
  return Object.keys(response);
}

export interface CachedFolderLookup {
  /** Folders whose alias exists, so their index survives a disk swap */
  folders: Set<string>;
  /** False when the cluster could not be reached while checking */
  elasticsearchUp: boolean;
}

/** One line per window for a cluster that fails every folder check at once */
export const indexCacheLogThrottle = new LogThrottle(30_000);

/** Alias checks that run in parallel without hammering Elasticsearch */
const CACHE_CHECK_CONCURRENCY = 8;

/**
 * Which of the given folders already have a search cache in Elasticsearch
 * (their alias exists). Aliases are named after folder paths and persist in
 * ES independently of the disks, so after a disk swap this tells which of
 * the currently mounted folders can be searched right away — a reindex is
 * only needed for the rest.
 *
 * A folder whose check fails (ES down mid-request) counts as uncached: the
 * status page should never 500 because of one hiccup.
 */
export async function listCachedFolders(folderPaths: string[]): Promise<CachedFolderLookup> {
  const folders = new Set<string>();
  let unavailable = 0;
  await runPool(folderPaths, CACHE_CHECK_CONCURRENCY, async (folderPath) => {
    const alias = getIndexNameFromFolderPath(folderPath);
    try {
      const exists = await getProbeClient().indices.existsAlias({ name: alias });
      if (exists) {
        folders.add(folderPath);
      }
    } catch (error) {
      if (isElasticsearchUnavailable(error)) {
        // Every folder fails at once when the cluster is gone: count them and
        // say it once, instead of one warning per folder
        unavailable += 1;
        noteElasticsearchUnavailable();
        return;
      }
      logger.warn(
        `Cannot check the index cache of ${folderPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });
  if (unavailable > 0 && indexCacheLogThrottle.shouldLog()) {
    logger.warn(
      `Cannot check the index cache of ${unavailable} folder(s): Elasticsearch is not reachable (further failures log once per 30s)`,
    );
  }
  return { folders, elasticsearchUp: unavailable === 0 };
}

/**
 * Point the folder alias at `indexName` and drop every other physical index
 * of the folder (the previous version and any orphans). Also migrates the
 * legacy layout where a concrete index carried the alias name.
 */
export async function promoteIndexVersion(folderPath: string, indexName: string): Promise<void> {
  const esClient = getElasticsearchClient();
  const alias = getIndexNameFromFolderPath(folderPath);

  await esClient.indices.refresh({ index: indexName });

  const previous = (await getIndexVersions(folderPath)).filter((name) => name !== indexName);

  const legacyIndexExists =
    previous.length === 0 &&
    (await esClient.indices.exists({ index: alias })) &&
    !(await esClient.indices.existsAlias({ name: alias }));
  if (legacyIndexExists) {
    logger.info(`Removing legacy index ${alias} to make room for the alias`);
    await esClient.indices.delete({ index: alias });
  }

  // Everything before this line may fail and leave the old index untouched;
  // everything after the swap is best-effort cleanup that must never throw —
  // an exception here used to propagate to scanFolder, which then discarded
  // the index that was ALREADY the alias target (silent empty search results).
  await esClient.indices.updateAliases({
    actions: [...previous.map((index) => ({ remove: { index, alias } })), { add: { index: indexName, alias } }],
  });

  const stale = new Set([
    ...previous,
    ...(await listAllIndexVersions(folderPath)).filter((name) => name !== indexName),
  ]);
  for (const index of stale) {
    try {
      await esClient.indices.delete({ index, ignore_unavailable: true });
      logger.info(`Index ${index} deleted`);
    } catch (error) {
      // Best-effort: an orphaned index is dead weight, never a correctness
      // problem — the next successful reindex sweeps it again.
      logger.warn(`Cannot delete stale index ${index}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  logger.info(`Alias ${alias} now points at ${indexName} for folder: ${folderPath}`);
}

/**
 * Delete a physical index that never got promoted (failed reindex).
 */
export async function discardIndexVersion(indexName: string): Promise<void> {
  const esClient = getElasticsearchClient();
  await esClient.indices.delete({ index: indexName, ignore_unavailable: true });
  logger.info(`Index ${indexName} discarded`);
}

/**
 * First-time creations in flight, per folder. Two callers that both see "no
 * alias" would each create a physical index, and the later promote deletes
 * the version the first caller is writing into: the document is then missing
 * from search until the next full reindex. Callers that arrive while a
 * creation runs share its result instead of starting a second one.
 */
const indexCreationsInFlight = new Map<string, Promise<void>>();

/**
 * Make sure the folder has a searchable (possibly empty) index behind its
 * alias. No-op when the alias already exists.
 */
export async function createIndex(folderPath: string): Promise<void> {
  const pending = indexCreationsInFlight.get(folderPath);
  if (pending) {
    return pending;
  }

  const creation = createFolderIndex(folderPath).finally(() => {
    // Only clear our own entry: a failed attempt must not be cached, and a
    // newer creation may already have replaced it.
    if (indexCreationsInFlight.get(folderPath) === creation) {
      indexCreationsInFlight.delete(folderPath);
    }
  });
  indexCreationsInFlight.set(folderPath, creation);
  return creation;
}

async function createFolderIndex(folderPath: string): Promise<void> {
  const esClient = getElasticsearchClient();
  const alias = getIndexNameFromFolderPath(folderPath);

  if (await esClient.indices.existsAlias({ name: alias })) {
    return;
  }

  const indexName = await createIndexVersion(folderPath);
  await promoteIndexVersion(folderPath, indexName);
}

export async function createAllIndices(): Promise<void> {
  for (const folderPath of getVideosFolderPaths()) {
    await createIndex(folderPath);
  }
}

/**
 * Drop the folder's alias and every physical index behind it (including a
 * legacy concrete index with the alias name).
 */
export async function deleteIndex(folderPath: string): Promise<void> {
  const esClient = getElasticsearchClient();
  const alias = getIndexNameFromFolderPath(folderPath);

  const versions = await getIndexVersions(folderPath);
  for (const index of versions) {
    await esClient.indices.delete({ index, ignore_unavailable: true });
    logger.info(`Index ${index} deleted`);
  }
  if (versions.length === 0 && (await esClient.indices.exists({ index: alias }))) {
    await esClient.indices.delete({ index: alias });
    logger.info(`Legacy index ${alias} deleted`);
  }
}

/**
 * Replace the folder's index with a fresh empty one (current mapping).
 * Documents are lost — run a reindex afterwards.
 */
export async function recreateIndex(folderPath: string): Promise<void> {
  const indexName = await createIndexVersion(folderPath);
  await promoteIndexVersion(folderPath, indexName);
  logger.info(`Index recreated for folder: ${folderPath}`);
}

export async function deleteAllIndices(): Promise<void> {
  for (const folderPath of getVideosFolderPaths()) {
    await deleteIndex(folderPath);
  }
}

export async function refreshIndex(folderPath: string): Promise<void> {
  const esClient = getElasticsearchClient();
  await esClient.indices.refresh({ index: getIndexNameFromFolderPath(folderPath) });
}

// ---------------------------------------------------------------------------
// Index recreation status (single process-wide job)
// ---------------------------------------------------------------------------

const MAX_RECREATE_STATUS_ERRORS = 20;

function idleRecreateStatus(): RecreateIndicesStatus {
  return { running: false, foldersDone: 0, foldersTotal: 0, errors: [] };
}

let recreateStatus: RecreateIndicesStatus = idleRecreateStatus();

export function getRecreateIndicesStatus(): RecreateIndicesStatus {
  return { ...recreateStatus, errors: [...recreateStatus.errors] };
}

export function isRecreateIndicesRunning(): boolean {
  return recreateStatus.running;
}

/**
 * Replace every folder's Elasticsearch index with a fresh empty one (current
 * mapping). Documents are lost — run a reindex afterwards. Per-folder failures
 * are recorded in the process-wide status (visible via
 * `getRecreateIndicesStatus()`) and do not stop the remaining folders.
 */
export async function recreateAllIndices(): Promise<void> {
  if (recreateStatus.running) {
    throw new Error('Index recreation is already running');
  }
  const folderPaths = getVideosFolderPaths();
  recreateStatus = {
    ...idleRecreateStatus(),
    running: true,
    startedAt: new Date().toISOString(),
    foldersTotal: folderPaths.length,
  };
  try {
    for (const folderPath of folderPaths) {
      try {
        await recreateIndex(folderPath);
      } catch (error) {
        const message = `Folder ${folderPath}: ${error instanceof Error ? error.message : String(error)}`;
        recreateStatus.lastError = message;
        if (recreateStatus.errors.length < MAX_RECREATE_STATUS_ERRORS) {
          recreateStatus.errors.push(message);
        }
      }
      recreateStatus.foldersDone += 1;
    }
  } finally {
    recreateStatus.running = false;
    recreateStatus.finishedAt = new Date().toISOString();
  }
}

/**
 * Delete physical index versions that are not behind their folder alias —
 * orphans left by a reindex that crashed mid-way (cleanup normally lives in
 * promoteIndexVersion). Runs at startup; failures are logged, never thrown,
 * because ES may simply be down at boot.
 */
export async function sweepOrphanIndexVersions(folderPaths: string[] = getVideosFolderPaths()): Promise<void> {
  for (const folderPath of folderPaths) {
    try {
      const aliasTargets = new Set(await getIndexVersions(folderPath));
      const all = await listAllIndexVersions(folderPath);
      for (const index of all) {
        if (!aliasTargets.has(index)) {
          await deleteIndexBestEffort(index);
        }
      }
    } catch (error) {
      logger.warn(`Cannot sweep orphans of ${folderPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** Delete an orphan index, logging either way — cleanup must never throw */
async function deleteIndexBestEffort(index: string): Promise<void> {
  try {
    await getElasticsearchClient().indices.delete({ index, ignore_unavailable: true });
    logger.info(`Swept orphan index ${index}`);
  } catch (error) {
    logger.warn(`Cannot delete orphan index ${index}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Log a warning for indices whose mapping predates the current analyzer
 * (they keep the old `standard` search behavior until a manual reindex).
 */
export async function warnOnLegacyMappings(folderPaths: string[] = getVideosFolderPaths()): Promise<void> {
  for (const folderPath of folderPaths) {
    try {
      const alias = getIndexNameFromFolderPath(folderPath);
      const mapping = await getProbeClient().indices.getMapping({ index: alias, ignore_unavailable: true });
      const indexMapping = mapping[Object.keys(mapping)[0] ?? ''];
      const analyzer = (indexMapping?.mappings?.properties?.title as { analyzer?: string } | undefined)?.analyzer;
      if (analyzer !== undefined && analyzer !== SEARCH_ANALYZER) {
        logger.warn(
          `Folder ${folderPath}: index mapping uses analyzer "${analyzer}" — reindex to switch to "${SEARCH_ANALYZER}"`,
        );
      }
    } catch {
      // ES down at boot — the warning is cosmetic, nothing to do here
    }
  }
}
