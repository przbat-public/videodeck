import { z } from 'zod';

/**
 * Zod schemas for the API response contract. The corresponding TypeScript
 * types are DERIVED from these schemas (`z.infer`) and re-exported by
 * `shared/api.ts`, so the runtime validation and the static types can never
 * drift apart.
 *
 * The client parses every response with these schemas (parse, don't trust);
 * the server's route tests assert its responses satisfy them.
 */

export const ApiErrorSchema = z.object({
  error: z.string(),
  message: z.string().optional(),
});

export const VideoCommentSchema = z.object({
  id: z.string(),
  parent: z.union([z.string(), z.literal('root')]).optional(),
  text: z.string(),
  like_count: z.number().optional(),
  author_id: z.string().optional(),
  author: z.string().optional(),
  author_thumbnail: z.string().optional(),
  author_is_uploader: z.boolean().optional(),
  author_is_verified: z.boolean().optional(),
  author_url: z.string().optional(),
  is_favorited: z.boolean().optional(),
  _time_text: z.string().optional(),
  timestamp: z.number().optional(),
  is_pinned: z.boolean().optional(),
});

/** Comment tree node: a flat comment plus its nested replies */
export interface CommentWithRepliesType {
  id?: string | undefined;
  author?: string | undefined;
  author_id?: string | undefined;
  text?: string | undefined;
  like_count?: number | undefined;
  timestamp?: number | undefined;
  time_parsed?: string | undefined;
  time_text?: string | undefined;
  _time_text?: string | undefined;
  is_favorited?: boolean | undefined;
  author_thumbnail?: string | undefined;
  author_is_uploader?: boolean | undefined;
  parent?: string | undefined;
  replies?: CommentWithRepliesType[] | undefined;
  reply_count?: number | undefined;
  /** yt-dlp adds fields we do not model; they are passed through untouched */
  [key: string]: unknown;
}

export const CommentWithRepliesSchema: z.ZodType<CommentWithRepliesType> = z
  .object({
    id: z.string().optional(),
    author: z.string().optional(),
    author_id: z.string().optional(),
    text: z.string().optional(),
    like_count: z.number().optional(),
    timestamp: z.number().optional(),
    time_parsed: z.string().optional(),
    time_text: z.string().optional(),
    _time_text: z.string().optional(),
    is_favorited: z.boolean().optional(),
    author_thumbnail: z.string().optional(),
    author_is_uploader: z.boolean().optional(),
    parent: z.string().optional(),
    replies: z.array(z.lazy(() => CommentWithRepliesSchema)).optional(),
    reply_count: z.number().optional(),
  })
  .passthrough();

export const VideoListItemSchema = z.object({
  baseName: z.string(),
  videoId: z.string().optional(),
  title: z.string(),
  description: z.string(),
  videoPath: z.string(),
  thumbnailPath: z.string(),
  folderPath: z.string(),
  uploadDate: z.string().optional(),
  viewCount: z.number().optional(),
  likeCount: z.number().optional(),
  channelName: z.string().optional(),
  comments: z.array(VideoCommentSchema),
  subtitlePath: z.string().optional(),
  // search-only; must be absent from responses (never parsed here)
  transcriptText: z.string().optional(),
});

export const VideoDetailsSchema = z.object({
  title: z.string(),
  description: z.string(),
  uploadDate: z.string(),
  duration: z.string(),
  viewCount: z.number(),
  likeCount: z.number(),
  channelName: z.string(),
  comments: z.array(CommentWithRepliesSchema),
  commentCount: z.number(),
  videoPath: z.string(),
  thumbnailPath: z.string(),
  subtitlePath: z.string().optional(),
  folderPath: z.string(),
});

export const SearchResponseSchema = z.object({
  videos: z.array(VideoListItemSchema),
  totalCount: z.number(),
});

export const CategoriesResponseSchema = z.object({
  categories: z.array(z.string()),
});

export const VideoDetailsResponseSchema = z.object({
  details: VideoDetailsSchema,
});

export const VideoSummaryResponseSchema = z.object({
  summary: z.string(),
  truncated: z.literal(true).optional(),
});

export const ReindexStatusSchema = z.object({
  running: z.boolean(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  currentFolder: z.string().optional(),
  foldersDone: z.number(),
  foldersTotal: z.number(),
  filesDone: z.number(),
  filesTotal: z.number(),
  indexed: z.number(),
  skipped: z.number(),
  errors: z.array(z.string()),
  lastError: z.string().optional(),
});

export const DownloadOptionsSchema = z.object({
  maxHeight: z.number(),
  subLangs: z.array(z.string()),
  writeComments: z.boolean(),
});

export const FolderConfigSchema = z
  .object({
    channelUrl: z.string().optional(),
    category: z.string().optional(),
    maxHeight: z.number().optional(),
    subLangs: z.array(z.string()).optional(),
    writeComments: z.boolean().optional(),
  })
  .passthrough();

export const StatusResponseSchema = z.object({
  videosFolderPath: z.array(z.string()),
  folderConfigs: z.record(z.string(), z.union([FolderConfigSchema, z.null()])),
  downloadDefaults: DownloadOptionsSchema,
  status: z.literal('ok'),
});

export const ChannelVideoSchema = z.object({
  title: z.string(),
  url: z.string(),
  id: z.string(),
});

export const FolderListResponseSchema = z.object({
  videos: z.array(ChannelVideoSchema),
  downloadStatuses: z.record(z.string(), z.boolean()),
  lastUpdatedDates: z.record(z.string(), z.string()),
});

export const QueueJobSchema = z.object({
  id: z.string(),
  folderPath: z.string(),
  videoId: z.string(),
  videoUrl: z.string(),
  title: z.string().optional(),
  type: z.enum(['download', 'update']),
  baseName: z.string().optional(),
  options: DownloadOptionsSchema.optional(),
  status: z.enum(['queued', 'running', 'done', 'error', 'cancelled']),
  progress: z.number().optional(),
  log: z.array(z.string()),
  logLineCount: z.number(),
  createdAt: z.string(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  error: z.string().optional(),
  exitCode: z.number().nullable().optional(),
});

export const SkippedVideoSchema = z.object({
  videoId: z.string(),
  reason: z.string(),
});

export const EnqueueJobsResponseSchema = z.object({
  jobs: z.array(QueueJobSchema),
  skipped: z.array(SkippedVideoSchema),
});

export const QueueListResponseSchema = z.object({
  jobs: z.array(QueueJobSchema),
});

export const ListExistsResponseSchema = z.object({
  exists: z.boolean(),
});

export const VideoDownloadedResponseSchema = z.object({
  downloaded: z.boolean(),
});

export const RebuildIndexResponseSchema = z.object({
  success: z.literal(true),
  count: z.number(),
  builtAt: z.string(),
});

export const DownloadPlaylistResponseSchema = z.object({
  success: z.literal(true),
  message: z.string(),
  listPath: z.string(),
  videoCount: z.number(),
});

export const SaveFolderConfigResponseSchema = z.object({
  success: z.literal(true),
  config: FolderConfigSchema,
});

/** Derived contract types (re-exported from api.ts) */
export type VideoComment = z.infer<typeof VideoCommentSchema>;
export type CommentWithReplies = z.infer<typeof CommentWithRepliesSchema>;
export type VideoListItem = z.infer<typeof VideoListItemSchema>;
export type VideoDetails = z.infer<typeof VideoDetailsSchema>;
export type SearchResponse = z.infer<typeof SearchResponseSchema>;
export type CategoriesResponse = z.infer<typeof CategoriesResponseSchema>;
export type VideoDetailsResponse = z.infer<typeof VideoDetailsResponseSchema>;
export type VideoSummaryResponse = z.infer<typeof VideoSummaryResponseSchema>;
export type ReindexStatus = z.infer<typeof ReindexStatusSchema>;
export type DownloadOptions = z.infer<typeof DownloadOptionsSchema>;
export type FolderConfig = z.infer<typeof FolderConfigSchema>;
export type StatusResponse = z.infer<typeof StatusResponseSchema>;
export type ChannelVideo = z.infer<typeof ChannelVideoSchema>;
export type FolderListResponse = z.infer<typeof FolderListResponseSchema>;
export type QueueJob = z.infer<typeof QueueJobSchema>;
export type SkippedVideo = z.infer<typeof SkippedVideoSchema>;
export type EnqueueJobsResponse = z.infer<typeof EnqueueJobsResponseSchema>;
export type QueueListResponse = z.infer<typeof QueueListResponseSchema>;
export type ListExistsResponse = z.infer<typeof ListExistsResponseSchema>;
export type VideoDownloadedResponse = z.infer<typeof VideoDownloadedResponseSchema>;
export type RebuildIndexResponse = z.infer<typeof RebuildIndexResponseSchema>;
export type DownloadPlaylistResponse = z.infer<typeof DownloadPlaylistResponseSchema>;
export type SaveFolderConfigResponse = z.infer<typeof SaveFolderConfigResponseSchema>;
export type ApiError = z.infer<typeof ApiErrorSchema>;
