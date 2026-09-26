/**
 * Public surface of the Elasticsearch service.
 *
 * The implementation lives in ./elasticsearch, split along four seams:
 * connection (client singletons, outage state, health probe), index lifecycle
 * (versions, aliases, recreation, orphan sweep), bulk indexing (document
 * mapping and writes) and search (queries, paging, highlights, single-document
 * reads).
 *
 * This module re-exports every name it exported before the split, so importers
 * and tests keep working without changes. New internals belong in the module
 * they serve, not here.
 */

export type { BulkIndexOptions, VideoDocument } from './elasticsearch/bulkIndexing';
export {
  bulkIndexDocuments,
  bulkIndexVideos,
  deleteAllVideos,
  deleteAllVideosFromFolder,
  estimateDocumentBytes,
  fromDocument,
  indexVideo,
  toDocument,
} from './elasticsearch/bulkIndexing';

export {
  checkElasticsearchConnection,
  clearElasticsearchOutage,
  elasticsearchUpGauge,
  getElasticsearchClient,
  getProbeClient,
  noteElasticsearchUnavailable,
  resetElasticsearchClient,
  setElasticsearchClient,
} from './elasticsearch/connection';

export type { CachedFolderLookup } from './elasticsearch/indexLifecycle';
export {
  buildIndexVersionName,
  createAllIndices,
  createIndex,
  createIndexVersion,
  deleteAllIndices,
  deleteIndex,
  discardIndexVersion,
  getIndexNameFromFolderPath,
  getIndexVersions,
  getRecreateIndicesStatus,
  indexCacheLogThrottle,
  isRecreateIndicesRunning,
  listAllIndexVersions,
  listCachedFolders,
  promoteIndexVersion,
  recreateAllIndices,
  recreateIndex,
  refreshIndex,
  sweepOrphanIndexVersions,
  warnOnLegacyMappings,
} from './elasticsearch/indexLifecycle';

export type { ChannelNames, SearchOptions } from './elasticsearch/search';
export {
  getAllVideos,
  getVideoByBaseName,
  getVideoByFilePath,
  getVideoByVideoId,
  listChannelNames,
  SEARCH_DEFAULT_LIMIT,
  SEARCH_FIELDS,
  SEARCH_MAX_LIMIT,
  searchVideos,
  searchVideosWithTotal,
} from './elasticsearch/search';
