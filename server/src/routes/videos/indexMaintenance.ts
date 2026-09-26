import type {
  AcceptedResponse,
  ApiError,
  RecreateIndicesStatus,
  ReindexConflictResponse,
  ReindexStatus,
} from '@videodeck/shared/api';
import {
  getRecreateIndicesStatus,
  isRecreateIndicesRunning,
  recreateAllIndices,
} from '../../services/elasticsearchService';
import { getReindexStatus, isReindexRunning, refreshVideosCache } from '../../services/videoScanner';
import { logger } from '../../utils/logger';
import type { NoParams, RouteHandler } from '../http';
import { readString } from '../http';

/**
 * The two index maintenance jobs and their status endpoints.
 *
 * A reindex and an index recreation both rewrite the folder aliases, so they
 * must not overlap. The service flags cover a running job; the module-level
 * `indexMaintenanceRunning` below also covers the window between accepting a
 * request and the service reporting itself as running, and it is one flag for
 * both jobs, which is why they share a module.
 */

/**
 * One index maintenance job at a time. A reindex and an index recreation both
 * rewrite the folder aliases, so running them together interleaves the alias
 * promotions and orphans the index the other job is writing into. The service
 * flags cover the running job itself; `indexMaintenanceRunning` also covers
 * the window between accepting a request and the service reporting itself as
 * running, and the service flags also catch a job started outside these routes.
 */
let indexMaintenanceRunning = false;

/** True while a reindex or an index recreation is under way */
function isIndexMaintenanceRunning(): boolean {
  return indexMaintenanceRunning || isReindexRunning() || isRecreateIndicesRunning();
}

/**
 * Tests: forget a job accepted by these routes. The flag is one copy for the
 * whole process on purpose (the two jobs rewrite the same aliases), so it
 * outlives a test that only stubs the service flags; without this a test that
 * started a job hands the next one a 409.
 */
export function resetIndexMaintenanceState(): void {
  indexMaintenanceRunning = false;
}

// GET /api/videos/refreshCache/status - Progress of the running/last reindex
export const getRefreshStatus: RouteHandler<NoParams, ReindexStatus> = (_req, res) => {
  res.json(getReindexStatus());
};

// POST /api/videos/refreshCache - Refresh/reindex videos cache.
// ?onlyMissing=1 reindexes only the folders whose cache does not exist in
// Elasticsearch yet, so a swapped-in disk with a cache from a previous
// session is searched immediately and only new folders are scanned.
// POST (not GET) because starting a reindex is a side effect: a GET could be
// triggered by a cross-site navigation in browsers that do not send
// Sec-Fetch-Site.
export const startRefresh: RouteHandler<NoParams, AcceptedResponse | ReindexConflictResponse> = (req, res) => {
  if (isIndexMaintenanceRunning()) {
    res.status(409).json({
      error: 'Reindex already running',
      message: 'A reindex is already in progress',
      status: getReindexStatus(),
    });
    return;
  }

  const onlyMissingValue = readString(req.query.onlyMissing);
  const onlyMissing = onlyMissingValue === '1' || onlyMissingValue === 'true';
  logger.info(`Cache refresh requested${onlyMissing ? ' (onlyMissing)' : ''}...`);

  // Start the refresh process asynchronously (fire and forget)
  indexMaintenanceRunning = true;
  refreshVideosCache(onlyMissing ? { onlyMissing: true } : undefined)
    .catch((error: unknown) => {
      logger.error('Error refreshing cache in background:', error);
    })
    .finally(() => {
      indexMaintenanceRunning = false;
    });

  // Return immediately
  res.status(202).json({
    message: 'Cache refresh process started',
    status: 'ok',
  });
};

// GET /api/videos/recreateIndices/status - Progress of the running/last index recreation
export const getRecreateIndicesStatusHandler: RouteHandler<NoParams, RecreateIndicesStatus> = (_req, res) => {
  res.json(getRecreateIndicesStatus());
};

// POST /api/videos/recreateIndices - Recreate all Elasticsearch indices
export const recreateIndices: RouteHandler<NoParams, AcceptedResponse | ApiError> = (_req, res) => {
  if (isIndexMaintenanceRunning()) {
    res.status(409).json({
      error: 'Index recreation already running',
      message: 'Index recreation is already in progress',
    });
    return;
  }
  logger.info('Recreate indices requested...');

  // Start the recreate process asynchronously (fire and forget); the client
  // polls /api/videos/recreateIndices/status until it finishes.
  indexMaintenanceRunning = true;
  recreateAllIndices()
    .catch((error: unknown) => {
      logger.error('Error recreating indices in background:', error);
    })
    .finally(() => {
      indexMaintenanceRunning = false;
    });

  // Return immediately
  res.status(202).json({
    message: 'Indices recreation process started',
    status: 'ok',
  });
};
