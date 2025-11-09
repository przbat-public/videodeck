import { Client } from '@elastic/elasticsearch';
import { VideoListItem, SortOption } from '../types';
import { getVideosFolderPaths, ELASTICSEARCH_URL } from '../config';
import { createHash } from 'crypto';

const INDEX_PREFIX = 'videos';

let client: Client | null = null;

/**
 * Generate a safe index name from folder path using hash
 * Uses SHA-256 hash to create a consistent, safe index name
 */
export function getIndexNameFromFolderPath(folderPath: string): string {
  // Create SHA-256 hash of the folder path
  const hash = createHash('sha256').update(folderPath).digest('hex').substring(0, 16);
  return `${INDEX_PREFIX}_${hash}`;
}

/**
 * Get index names for searching across currently configured folders
 */
function getIndexPattern(): string | string[] {
  const folderPaths = getVideosFolderPaths();
  return folderPaths.map((folderPath) => getIndexNameFromFolderPath(folderPath));
}

/**
 * Initialize Elasticsearch client
 */
export const getElasticsearchClient = (): Client => {
  if (!client) {
    client = new Client({
      node: ELASTICSEARCH_URL,
    });
  }
  return client;
};

/**
 * Create the videos index for a specific folder path
 */
export async function createIndex(folderPath: string): Promise<void> {
  const esClient = getElasticsearchClient();
  const indexName = getIndexNameFromFolderPath(folderPath);

  const indexExists = await esClient.indices.exists({ index: indexName });

  if (indexExists) {
    console.log(`Index ${indexName} already exists`);
    return;
  }

  await esClient.indices.create({
    index: indexName,
    settings: {
      index: {
        mapping: {
          nested_objects: {
            limit: 100000, // Increase limit for videos with many comments
          },
        },
      },
    },
    mappings: {
      properties: {
        baseName: { type: 'keyword' },
        title: {
          type: 'text',
          analyzer: 'standard',
          fields: {
            keyword: { type: 'keyword' },
          },
        },
        description: {
          type: 'text',
          analyzer: 'standard',
        },
        videoPath: { type: 'keyword' },
        thumbnailPath: { type: 'keyword' },
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
        comments: {
          type: 'nested',
          properties: {
            id: { type: 'keyword' },
            parent: { type: 'keyword' },
            text: { type: 'text', analyzer: 'standard' },
            like_count: { type: 'integer' },
            author_id: { type: 'keyword' },
            author: { type: 'text' },
            author_thumbnail: { type: 'keyword' },
            author_is_uploader: { type: 'boolean' },
            author_is_verified: { type: 'boolean' },
            author_url: { type: 'keyword' },
            is_favorited: { type: 'boolean' },
            _time_text: { type: 'keyword' },
            timestamp: { type: 'long' },
            is_pinned: { type: 'boolean' },
          },
        },
      },
    },
  });

  console.log(`Index ${indexName} created successfully for folder: ${folderPath}`);
}

/**
 * Create indices for all configured folders
 */
export async function createAllIndices(): Promise<void> {
  const folderPaths = getVideosFolderPaths();
  
  for (const folderPath of folderPaths) {
    await createIndex(folderPath);
  }
}

/**
 * Index a single video
 */
export async function indexVideo(video: VideoListItem): Promise<void> {
  const esClient = getElasticsearchClient();
  const indexName = getIndexNameFromFolderPath(video.folderPath);

  // Use videoId as ID if available, otherwise fallback to baseName
  const documentId = video.videoId || video.baseName;

  await esClient.index({
    index: indexName,
    id: documentId,
    document: video,
  });
}

/**
 * Bulk index videos (videos are grouped by folderPath and indexed to appropriate indices)
 */
export async function bulkIndexVideos(videos: VideoListItem[]): Promise<void> {
  const esClient = getElasticsearchClient();

  if (videos.length === 0) {
    return;
  }

  // Group videos by folderPath
  const videosByFolder = new Map<string, VideoListItem[]>();
  for (const video of videos) {
    const folderVideos = videosByFolder.get(video.folderPath) || [];
    folderVideos.push(video);
    videosByFolder.set(video.folderPath, folderVideos);
  }

  // Index each folder's videos separately
  for (const [folderPath, folderVideos] of videosByFolder) {
    const indexName = getIndexNameFromFolderPath(folderPath);
    
    // Ensure index exists before indexing
    await createIndex(folderPath);
    
    const operations = folderVideos.flatMap((video) => [
      { index: { _index: indexName, _id: video.videoId || video.baseName } },
      video,
    ]);

    const response = await esClient.bulk({ operations });

    if (response.errors) {
      const errors = response.items
        .filter((item: any) => item.index?.error)
        .map((item: any) => item.index?.error);
      console.error(`Some videos failed to index in ${indexName}:`, errors);
    } else {
      console.log(`Successfully indexed ${folderVideos.length} videos to ${indexName}`);
    }

    // Refresh the index to make documents searchable immediately
    await esClient.indices.refresh({ index: indexName });
  }
}

/**
 * Delete the videos index for a specific folder (useful for reindexing)
 */
export async function deleteIndex(folderPath: string): Promise<void> {
  const esClient = getElasticsearchClient();
  const indexName = getIndexNameFromFolderPath(folderPath);

  const indexExists = await esClient.indices.exists({ index: indexName });

  if (indexExists) {
    await esClient.indices.delete({ index: indexName });
    console.log(`Index ${indexName} deleted successfully`);
  }
}

/**
 * Recreate an index with updated settings (deletes and recreates)
 * Useful when index settings need to be updated (e.g., nested_objects.limit)
 * Note: This will delete all documents in the index - reindexing is required after calling this
 */
export async function recreateIndex(folderPath: string): Promise<void> {
  await deleteIndex(folderPath);
  await createIndex(folderPath);
  console.log(`Index recreated for folder: ${folderPath}`);
}

/**
 * Delete all video indices (useful for reindexing)
 */
export async function deleteAllIndices(): Promise<void> {
  const folderPaths = getVideosFolderPaths();
  
  for (const folderPath of folderPaths) {
    await deleteIndex(folderPath);
  }
}

/**
 * Recreate all indices with updated settings (deletes and recreates)
 * Useful when index settings need to be updated (e.g., nested_objects.limit)
 * Note: This will delete all documents in all indices - reindexing is required after calling this
 */
export async function recreateAllIndices(): Promise<void> {
  const folderPaths = getVideosFolderPaths();
  
  for (const folderPath of folderPaths) {
    await recreateIndex(folderPath);
  }
}

/**
 * Delete all videos from a specific folder's index
 */
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

/**
 * Delete all videos from all indices
 */
export async function deleteAllVideos(): Promise<void> {
  const folderPaths = getVideosFolderPaths();
  
  for (const folderPath of folderPaths) {
    await deleteAllVideosFromFolder(folderPath);
  }
}

/**
 * Build Elasticsearch sort options from SortOption
 */
function buildSortOptions(sortOption: SortOption): any[] {
  switch (sortOption) {
    case 'date-desc':
      return [{ uploadDate: { order: 'desc', missing: '_last' } }];
    case 'date-asc':
      return [{ uploadDate: { order: 'asc', missing: '_last' } }];
    case 'views-desc':
      return [{ viewCount: { order: 'desc', missing: '_last' } }];
    case 'views-asc':
      return [{ viewCount: { order: 'asc', missing: '_last' } }];
    case 'likes-desc':
      return [{ likeCount: { order: 'desc', missing: '_last' } }];
    case 'likes-asc':
      return [{ likeCount: { order: 'asc', missing: '_last' } }];
    default:
      return [{ uploadDate: { order: 'desc', missing: '_last' } }];
  }
}

/**
 * Search videos with query and sorting across all folders
 */
export async function searchVideos(
  query?: string,
  sortOption: SortOption = 'date-desc'
): Promise<VideoListItem[]> {
  const esClient = getElasticsearchClient();

  // Build search query
  let searchQuery: any = { match_all: {} };

  if (query && query.trim().length > 0) {
    const searchTerm = query.trim();
    searchQuery = {
      bool: {
        should: [
          // Search in non-nested fields
          {
            multi_match: {
              query: searchTerm,
              fields: ['baseName^4', 'title^3', 'description^2'],
              type: 'best_fields',
              fuzziness: 'AUTO',
            },
          },
          // Search in nested comments
          {
            nested: {
              path: 'comments',
              query: {
                match: {
                  'comments.text': {
                    query: searchTerm,
                    fuzziness: 'AUTO',
                  },
                },
              },
              score_mode: 'sum',
            },
          },
        ],
        minimum_should_match: 1,
      },
    };
  }

  // Search across all video indices
  // Exclude comments from search results to save memory - they're only needed for individual video details
  // Limit results to prevent memory issues (consider adding pagination for larger result sets)
  const response = await esClient.search<VideoListItem>({
    index: getIndexPattern(),
    query: searchQuery,
    sort: buildSortOptions(sortOption),
    size: 100,
    _source: {
      excludes: ['comments'],
    },
  });

  return response.hits.hits.map((hit) => {
    if (!hit._source) {
      throw new Error(`Video document ${hit._id} has no _source field`);
    }
    // Ensure comments field is empty array for search results
    const video = hit._source as VideoListItem;
    return {
      ...video,
      comments: [],
    };
  });
}

/**
 * Get all videos (without search query)
 */
export async function getAllVideos(sortOption: SortOption = 'date-desc'): Promise<VideoListItem[]> {
  return searchVideos(undefined, sortOption);
}

/**
 * Get a single video by videoId (YouTube ID) (searches across all indices)
 * Uses document ID lookup for better performance
 */
export async function getVideoByVideoId(videoId: string): Promise<VideoListItem | null> {
  const esClient = getElasticsearchClient();

  // Try to get document by ID across all indices
  // Since we don't know which index contains the document, we search by IDs query
  const response = await esClient.search<VideoListItem>({
    index: getIndexPattern(),
    query: {
      ids: {
        values: [videoId],
      },
    },
    size: 1,
  });

  if (response.hits.hits.length === 0) {
    return null;
  }

  const hit = response.hits.hits[0];
  if (!hit._source) {
    return null;
  }

  return hit._source as VideoListItem;
}

/**
 * Get a single video by baseName (searches across all indices)
 */
export async function getVideoByBaseName(baseName: string): Promise<VideoListItem | null> {
  const esClient = getElasticsearchClient();

  // Search across all indices
  const response = await esClient.search<VideoListItem>({
    index: getIndexPattern(),
    query: {
      term: {
        baseName: baseName,
      },
    },
    size: 1,
  });

  if (response.hits.hits.length === 0) {
    return null;
  }

  const hit = response.hits.hits[0];
  if (!hit._source) {
    return null;
  }

  return hit._source as VideoListItem;
}

/**
 * Refresh index for a specific folder
 */
export async function refreshIndex(folderPath: string): Promise<void> {
  const esClient = getElasticsearchClient();
  const indexName = getIndexNameFromFolderPath(folderPath);
  await esClient.indices.refresh({ index: indexName });
}

/**
 * Get total count of all indexed videos across all indices
 */
export async function getTotalVideoCount(): Promise<number> {
  const esClient = getElasticsearchClient();
  
  const response = await esClient.count({
    index: getIndexPattern(),
    query: {
      match_all: {},
    },
  });
  
  return response.count;
}

/**
 * Check if Elasticsearch is available
 */
export async function checkElasticsearchConnection(): Promise<boolean> {
  try {
    const esClient = getElasticsearchClient();
    await esClient.ping();
    return true;
  } catch (error) {
    console.error('Elasticsearch connection failed:', error);
    return false;
  }
}


