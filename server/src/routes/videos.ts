import express from 'express';
import { getComments } from './videos/comments';
import { getDetails } from './videos/details';
import { serveFile } from './videos/files';
import {
  getRecreateIndicesStatusHandler,
  getRefreshStatus,
  recreateIndices,
  startRefresh,
} from './videos/indexMaintenance';
import { getCategories, getChannelNames, search } from './videos/search';
import { getSummary } from './videos/summary';

/**
 * Public surface of the video routes.
 *
 * The implementation lives in ./videos, split along seven seams: helpers (the
 * query parsers and the identifier lookup the read handlers share), search
 * (the search endpoint and its category and channel facets), summary (the
 * OpenAI summary), details (the metadata payload and its subtitle listing),
 * comments (one page of the comment tree), files (the only endpoint that reads
 * video bytes, with its allowlist and containment checks) and indexMaintenance
 * (the reindex and the index recreation, which share one running flag).
 *
 * What stayed here is the wiring, because the order of the registrations below
 * is behaviour: Express matches in registration order, so `/refreshCache/status`
 * and `/recreateIndices/status` stay ahead of the bare `/refreshCache` and
 * `/recreateIndices` they describe, and `/file/:filename` stays ahead of the
 * `/:identifier` routes.
 *
 * The handlers themselves keep the module-level constants they were before the
 * split: none of them needs a per-request instance, and `indexMaintenance`
 * keeps the single running flag for both jobs.
 */

const router = express.Router();

router.get('/refreshCache/status', getRefreshStatus);
router.post('/refreshCache', startRefresh);
router.get('/recreateIndices/status', getRecreateIndicesStatusHandler);
router.post('/recreateIndices', recreateIndices);
router.get('/search', search);
router.get('/categories', getCategories);
router.get('/channels', getChannelNames);
router.get('/file/:filename', serveFile);
router.get('/:identifier/summary', getSummary);
router.get('/:identifier/comments', getComments);
router.get('/:identifier/details', getDetails);

export default router;
