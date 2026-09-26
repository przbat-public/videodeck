import fs from 'node:fs/promises';
import path from 'node:path';
import type { FolderConfig, SaveFolderConfigResponse, StatusResponse } from '@videodeck/shared/api';
import { getVideosFolderPaths } from '../../config';
import { listCachedFolders } from '../../services/elasticsearchService';
import {
  DEFAULT_DOWNLOAD_OPTIONS,
  invalidateCategoryCache,
  readFolderConfig,
  validateFolderConfig,
} from '../../services/folderConfig';
import { writeJsonAtomic } from '../../utils/fsUtils';
import type { NoParams, RouteHandler } from '../http';
import { readBody } from '../http';
import { configBodySchema, firstZodError } from '../validation';
import { requireAllowedFolder } from './guards';

/**
 * GET /api/status and PUT /api/folder/config, plus the status cache they
 * share.
 *
 * The cache is module-level on purpose: one copy behind every router instance,
 * so a burst of status page loads reads the disks once. Saving a config drops
 * it, because the write changes what the status page reports.
 */

/** 5 s cache of GET /api/status keyed by the expanded folder list */
const STATUS_CACHE_TTL_MS = 5_000;
let statusCache: { key: string; readAt: number; body: StatusResponse } | null = null;

function readStatusCache(folderPaths: string[]): StatusResponse | undefined {
  const cached = statusCache;
  if (cached === null || cached.key !== folderPaths.join('\n') || Date.now() - cached.readAt >= STATUS_CACHE_TTL_MS) {
    return undefined;
  }
  return cached.body;
}

function writeStatusCache(folderPaths: string[], body: StatusResponse): void {
  statusCache = { key: folderPaths.join('\n'), readAt: Date.now(), body };
}

/** Tests: drop the status cache */
export function invalidateStatusCache(): void {
  statusCache = null;
}

export const getStatus: RouteHandler<NoParams, StatusResponse> = async (_req, res) => {
  const videosFolderPaths = getVideosFolderPaths();

  // The status page polls this endpoint; building it reads every folder's
  // config.json plus one ES alias check per folder (up to ~3 s over
  // external disks). Serve a 5 s cache so a burst of page loads cannot
  // hammer the drives or Elasticsearch.
  const cached = readStatusCache(videosFolderPaths);
  if (cached !== undefined) {
    res.json(cached);
    return;
  }

  // Configs live on an external disk: 56 folders read one after another
  // cost up to 3 s (the same reason categories are read in parallel).
  // readFolderConfig never throws, so the whole list is always built.
  // Elasticsearch absence must not take the page down: the folder list, the
  // configs and list.json presence all come from disk. An unreachable cluster
  // reports no cached folders and says so, and the client hides the per-row
  // index chips instead of claiming every channel lost its index.
  const [configs, cachedLookup] = await Promise.all([
    Promise.all(videosFolderPaths.map(readFolderConfig)),
    listCachedFolders(videosFolderPaths).catch(() => null),
  ]);
  const elasticsearchUp = cachedLookup?.elasticsearchUp ?? false;
  // A partial read is not reported as an index state: either the cluster
  // answered for every folder, or the response says it is down and the client
  // hides the per-row chips.
  const indexedFolders = elasticsearchUp
    ? videosFolderPaths.filter((folderPath) => cachedLookup?.folders.has(folderPath) === true)
    : [];
  const folderConfigs: Record<string, FolderConfig | null> = {};
  videosFolderPaths.forEach((folderPath, index) => {
    folderConfigs[folderPath] = configs[index] ?? null;
  });
  // list.json presence for every folder in one batched pass — the client
  // used to ask per folder (57 requests on a full status page)
  const listExists: Record<string, boolean> = {};
  await Promise.all(
    videosFolderPaths.map(async (folderPath) => {
      try {
        await fs.access(path.join(folderPath, 'list.json'));
        listExists[folderPath] = true;
      } catch {
        listExists[folderPath] = false;
      }
    }),
  );
  const body: StatusResponse = {
    videosFolderPath: videosFolderPaths,
    folderConfigs,
    downloadDefaults: DEFAULT_DOWNLOAD_OPTIONS,
    indexedFolders,
    listExists,
    elasticsearch: elasticsearchUp ? 'ok' : 'down',
    status: 'ok',
  };
  writeStatusCache(videosFolderPaths, body);
  res.json(body);
};

export const saveFolderConfig: RouteHandler<NoParams, SaveFolderConfigResponse> = async (req, res) => {
  const parsed = configBodySchema.safeParse(readBody(req));
  if (!parsed.success) {
    res.status(400).json({ error: firstZodError(parsed.error) });
    return;
  }
  const { folderPath: rawFolderPath, config } = parsed.data;

  const validationError = validateFolderConfig(config);
  if (validationError !== null) {
    res.status(400).json({ error: validationError });
    return;
  }
  // validateFolderConfig accepted it, so `config` is a plain object
  const validConfig: FolderConfig = { ...(config as FolderConfig) };
  if (typeof validConfig.category === 'string') {
    // Stored trimmed so the file matches what search compares against
    validConfig.category = validConfig.category.trim();
  }
  const folderPath = requireAllowedFolder(rawFolderPath, res);
  if (!folderPath) return;

  await fs.mkdir(folderPath, { recursive: true });
  await writeJsonAtomic(folderPath, 'config.json', validConfig);
  invalidateCategoryCache();
  invalidateStatusCache();
  res.json({ success: true, config: validConfig });
};
