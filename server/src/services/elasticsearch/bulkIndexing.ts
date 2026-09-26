import type { VideoListItem } from '@videodeck/shared/api';
import { getVideosFolderPaths } from '../../config';
import { logger } from '../../utils/logger';
import { getElasticsearchClient } from './connection';
import { createIndex, getIndexNameFromFolderPath } from './indexLifecycle';

/** Shape of a document stored in Elasticsearch */
export type VideoDocument = Omit<VideoListItem, 'comments'> & {
  commentsText?: string;
};

/** Convert a scanned video into the stored document */
export function toDocument(video: VideoListItem): VideoDocument {
  const { comments, ...rest } = video;
  const commentsText = (comments ?? [])
    .map((comment) => comment.text)
    .filter((text): text is string => typeof text === 'string' && text.length > 0)
    .join('\n');
  const document: VideoDocument = commentsText.length > 0 ? { ...rest, commentsText } : rest;
  // yt-dlp writes counts as numbers, but a hand-edited info.json can carry
  // strings — one such document used to fail the whole bulk (mapping
  // conflict with `integer`) and sink the entire folder's reindex.
  const viewCount = coerceInteger(document.viewCount);
  if (viewCount !== undefined) {
    document.viewCount = viewCount;
  } else {
    delete document.viewCount;
  }
  const likeCount = coerceInteger(document.likeCount);
  if (likeCount !== undefined) {
    document.likeCount = likeCount;
  } else {
    delete document.likeCount;
  }
  return document;
}

/** A non-negative integer, or undefined when the value is not a plausible count */
function coerceInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value);
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** Convert a stored document back into the API shape */
export function fromDocument(document: VideoDocument): VideoListItem {
  // Search-only blobs never leave the server; the (always empty) comments
  // array is not emitted either — it was pure payload bloat.
  const { commentsText, transcriptText, ...rest } = document;
  return rest;
}

// ---------------------------------------------------------------------------
// Writing documents
// ---------------------------------------------------------------------------

export interface BulkIndexOptions {
  /** Physical index to write into; defaults to each video's folder alias */
  index?: string;
  /** Refresh the target after writing (default true) */
  refresh?: boolean;
}

/**
 * Index a single video through its folder alias (upsert by video id).
 */
export async function indexVideo(video: VideoListItem): Promise<void> {
  const esClient = getElasticsearchClient();
  await createIndex(video.folderPath);

  await esClient.index({
    index: getIndexNameFromFolderPath(video.folderPath),
    id: video.videoId || video.baseName,
    document: toDocument(video),
    refresh: true,
  });
}

/**
 * Bulk index videos. With `options.index` everything goes into that physical
 * index (used by reindex); otherwise videos are grouped by folder and written
 * through the folder aliases. Returns how many documents were indexed and
 * how many per-item failures were skipped.
 */
export async function bulkIndexVideos(
  videos: VideoListItem[],
  options: BulkIndexOptions = {},
): Promise<{ indexed: number; skipped: number }> {
  if (videos.length === 0) {
    return { indexed: 0, skipped: 0 };
  }
  const refresh = options.refresh ?? true;

  const targets = new Map<string, VideoListItem[]>();
  if (options.index) {
    targets.set(options.index, videos);
  } else {
    for (const video of videos) {
      const indexName = getIndexNameFromFolderPath(video.folderPath);
      const group = targets.get(indexName) || [];
      group.push(video);
      targets.set(indexName, group);
    }
    for (const video of videos) {
      await createIndex(video.folderPath);
    }
  }

  let indexed = 0;
  let skipped = 0;
  for (const [indexName, group] of targets) {
    const result = await bulkIndexDocuments(indexName, group.map(toDocument), refresh);
    indexed += result.indexed;
    skipped += result.skipped;
  }
  return { indexed, skipped };
}

/**
 * Write already-flattened documents into one index with a single `_bulk`
 * request. Callers are responsible for keeping the batch under
 * Elasticsearch's `http.max_content_length` (100 MB by default).
 *
 * Per-item failures are skipped (counted and logged), so one malformed
 * document no longer sinks the whole folder's reindex. Only when EVERY
 * document fails (e.g. a real mapping conflict) does this throw — promoting
 * an empty index over a good one would silently empty the search results.
 */
export async function bulkIndexDocuments(
  indexName: string,
  documents: VideoDocument[],
  refresh = true,
): Promise<{ indexed: number; skipped: number }> {
  if (documents.length === 0) {
    return { indexed: 0, skipped: 0 };
  }
  const esClient = getElasticsearchClient();

  const operations = documents.flatMap((document) => [
    { index: { _index: indexName, _id: document.videoId || document.baseName } },
    document,
  ]);

  const response = await esClient.bulk({ operations });

  if (response.errors) {
    const failedIds = new Set(
      response.items
        .filter((item) => item.index?.error)
        .map((item) => item.index?._id)
        .filter((id): id is string => typeof id === 'string'),
    );
    if (failedIds.size === documents.length) {
      throw new Error(`Bulk indexing failed for all ${documents.length} videos in ${indexName}`);
    }
    logger.error(`${failedIds.size} videos failed to index in ${indexName} (skipped):`, [...failedIds].slice(0, 5));
    if (refresh) {
      await esClient.indices.refresh({ index: indexName });
    }
    return { indexed: documents.length - failedIds.size, skipped: failedIds.size };
  }

  if (refresh) {
    await esClient.indices.refresh({ index: indexName });
  }
  return { indexed: documents.length, skipped: 0 };
}

/**
 * Rough size of the serialized document — used to keep bulk requests small
 * without serializing twice.
 */
export function estimateDocumentBytes(document: VideoDocument): number {
  return (
    (document.commentsText?.length ?? 0) +
    (document.transcriptText?.length ?? 0) +
    (document.description?.length ?? 0) +
    (document.title?.length ?? 0) +
    512
  );
}

export async function deleteAllVideosFromFolder(folderPath: string): Promise<void> {
  const esClient = getElasticsearchClient();
  const indexName = getIndexNameFromFolderPath(folderPath);

  await esClient.deleteByQuery({
    index: indexName,
    query: {
      match_all: {},
    },
  });

  await esClient.indices.refresh({ index: indexName });
}

export async function deleteAllVideos(): Promise<void> {
  for (const folderPath of getVideosFolderPaths()) {
    await deleteAllVideosFromFolder(folderPath);
  }
}
