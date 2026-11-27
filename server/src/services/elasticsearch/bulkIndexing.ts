import type { VideoListItem } from '@videodeck/shared/api';
import { getVideosFolderPaths } from '../../config';
import { logger } from '../../utils/logger';
import { getElasticsearchClient } from './connection';
import { createIndex, getIndexNameFromFolderPath } from './indexLifecycle';

/** Shape of a document stored in Elasticsearch */
export type VideoDocument = Omit<VideoListItem, 'comments'> & {
  commentsText?: string;
};

/**
 * Most characters of comment text one document stores. A video with hundreds
 * of thousands of comments made a document past the 100 MB a cluster accepts
 * per request, so even a batch of one failed with a 413, and with it the
 * folder's whole reindex. At three UTF-8 bytes per character, a batch just
 * under REINDEX_BATCH_BYTES plus one document with its comments and its
 * transcript at their caps stays under that limit. The three bytes hold for
 * text without C0 control characters or lone surrogates, which JSON writes as
 * six-byte `\uXXXX` escapes. The title and the description have no cap, and
 * YouTube keeps both short.
 */
export const MAX_COMMENTS_CHARS = 10_000_000;

/**
 * The comment texts joined by newlines, whole comments only, as many as fit
 * in MAX_COMMENTS_CHARS. It stops at the first one that would pass the cap, so
 * what search keeps is the start of the list the info.json holds, never a
 * sample of it.
 */
function commentsTextOf(comments: VideoListItem['comments']): string {
  const kept: string[] = [];
  let length = 0;
  for (const { text } of comments ?? []) {
    if (typeof text !== 'string' || text.length === 0) {
      continue;
    }
    // The newline in front of every comment but the first counts too
    const lengthWithText = length + (kept.length > 0 ? 1 : 0) + text.length;
    if (lengthWithText > MAX_COMMENTS_CHARS) {
      break;
    }
    kept.push(text);
    length = lengthWithText;
  }
  return kept.join('\n');
}

/** Convert a scanned video into the stored document */
export function toDocument(video: VideoListItem): VideoDocument {
  const { comments, ...rest } = video;
  const commentsText = commentsTextOf(comments);
  const document: VideoDocument = commentsText.length > 0 ? { ...rest, commentsText } : rest;
  // yt-dlp writes counts as numbers, but a hand-edited info.json can carry
  // strings: one such document used to fail the whole bulk (a mapping
  // conflict with the numeric field) and sink the entire folder's reindex.
  // No clamp: a count past what the field holds (long for views, integer for
  // likes) is the cluster's to refuse, one skipped item.
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
 * The failed items are counted, not their ids: two stems of one video send
 * the same id twice, and a batch whose every item failed read as partly
 * written when those ids were folded into one.
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
    const failed = response.items.filter((item) => item.index?.error);
    if (failed.length >= documents.length) {
      throw new Error(`Bulk indexing failed for all ${documents.length} videos in ${indexName}`);
    }
    const failedIds = failed.map((item) => item.index?._id).filter((id): id is string => typeof id === 'string');
    logger.error(`${failed.length} videos failed to index in ${indexName} (skipped):`, failedIds.slice(0, 5));
    if (refresh) {
      await esClient.indices.refresh({ index: indexName });
    }
    return { indexed: documents.length - failed.length, skipped: failed.length };
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
