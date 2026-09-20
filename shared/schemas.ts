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
  /**
   * Machine-readable reason for the failures the client translates itself.
   * Only `elasticsearch_unavailable` (503) is defined so far.
   */
  code: z.string().optional(),
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
  .loose();

export const VideoListItemSchema = z.object({
  baseName: z.string(),
  videoId: z.string().optional(),
  title: z.string(),
  // Optional on purpose: search responses exclude the heavyweight fields
  // (full yt-dlp descriptions are MBs of payload) — the details endpoint
  // serves them from info.json instead.
  description: z.string().optional(),
  videoPath: z.string().optional(),
  thumbnailPath: z.string(),
  folderPath: z.string(),
  uploadDate: z.string().optional(),
  viewCount: z.number().optional(),
  likeCount: z.number().optional(),
  channelName: z.string().optional(),
  comments: z.array(VideoCommentSchema).optional(),
  subtitlePath: z.string().optional(),
  // search-only; must be absent from responses (never parsed here)
  transcriptText: z.string().optional(),
  /** ES highlight fragments (title/description/snippet) with \u0001\u0002 marks */
  highlights: z.record(z.string(), z.array(z.string())).optional(),
});

/**
 * Channel metadata for the UI: the distinct names behind the search filter,
 * and the channel each configured folder belongs to. The console's "search in
 * this channel" link needs the name, because the search filters by
 * `channelName`, not by folder path.
 */
export const ChannelsResponseSchema = z.object({
  channels: z.array(z.string()),
  folders: z.record(z.string(), z.string()),
});

/** One subtitle file actually on disk, with its language from the file name */
export const SubtitleTrackSchema = z.object({
  path: z.string(),
  lang: z.string().optional(),
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
  /** Primary subtitle (first track found); kept for summaries */
  subtitlePath: z.string().optional(),
  /** Every subtitle file the folder holds for this video */
  subtitles: z.array(SubtitleTrackSchema),
  folderPath: z.string(),
});

export const SearchResponseSchema = z.object({
  videos: z.array(VideoListItemSchema),
  totalCount: z.number(),
});

/** Default page size of the search endpoint (client and server share it) */
export const SEARCH_DEFAULT_PAGE_SIZE = 100;
/** Top-level comments per page (details response and /comments endpoint) */
export const COMMENTS_PAGE_SIZE = 50;

export const CategoriesResponseSchema = z.object({
  categories: z.array(z.string()),
});

export const VideoDetailsResponseSchema = z.object({
  details: VideoDetailsSchema,
});

/** GET /api/videos/:identifier/comments — one page of the comment tree */
export const CommentsResponseSchema = z.object({
  comments: z.array(CommentWithRepliesSchema),
  totalCount: z.number(),
  offset: z.number(),
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

/** GET /api/videos/recreateIndices/status (Elasticsearch-only index rebuild) */
export const RecreateIndicesStatusSchema = z.object({
  running: z.boolean(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  foldersDone: z.number(),
  foldersTotal: z.number(),
  errors: z.array(z.string()),
  lastError: z.string().optional(),
});

export const DownloadOptionsSchema = z.object({
  maxHeight: z.number(),
  subLangs: z.array(z.string()),
  writeComments: z.boolean(),
  /**
   * Extra yt-dlp flags appended after the built-in ones, e.g.
   * `--no-playlist`. Flags the pipeline depends on and dangerous flags
   * (`--exec`, `--proxy`, `--cookies*`, …) are rejected server-side;
   * see validateFolderConfig.
   */
  extraArgs: z.array(z.string()).optional(),
  /** Pass `--impersonate chrome` — the cookie-less answer to YouTube bot walls */
  impersonate: z.boolean().optional(),
  /** `-N N` parallel download fragments (1..16) */
  concurrentFragments: z.number().int().min(1).max(16).optional(),
  /** `--sponsorblock-remove sponsor,selfpromo,interaction` */
  sponsorblockRemove: z.boolean().optional(),
});

export const FolderConfigSchema = z
  .object({
    channelUrl: z.string().optional(),
    category: z.string().optional(),
    maxHeight: z.number().optional(),
    subLangs: z.array(z.string()).optional(),
    writeComments: z.boolean().optional(),
    extraArgs: z.array(z.string()).optional(),
    impersonate: z.boolean().optional(),
    concurrentFragments: z.number().int().min(1).max(16).optional(),
    sponsorblockRemove: z.boolean().optional(),
  })
  .loose();

export const StatusResponseSchema = z.object({
  videosFolderPath: z.array(z.string()),
  folderConfigs: z.record(z.string(), z.union([FolderConfigSchema, z.null()])),
  downloadDefaults: DownloadOptionsSchema,
  /**
   * Current folders that already have a search cache in Elasticsearch (their
   * alias exists) — after a disk swap these are ready to search without a
   * reindex, and `GET /api/videos/refreshCache?onlyMissing=1` skips them.
   */
  indexedFolders: z.array(z.string()),
  /** Which folders have a list.json (one request instead of one per folder) */
  listExists: z.record(z.string(), z.boolean()),
  /**
   * Whether the Elasticsearch read behind `indexedFolders` worked. When it is
   * `down`, the list is empty because nothing could be read, not because the
   * folders lost their index, so the console suppresses its index chips.
   */
  elasticsearch: z.enum(['ok', 'down']),
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

/**
 * Per-channel counts behind the download page's channel console. Only videos
 * `list.json` still contains are counted, `stale` marks downloads whose
 * metadata is older than a month (see `shared/dates.ts`), and `newestUpdate`
 * stays absent while the channel has nothing downloaded.
 */
export const FolderSummarySchema = z.object({
  videos: z.number().int().nonnegative(),
  downloaded: z.number().int().nonnegative(),
  notDownloaded: z.number().int().nonnegative(),
  stale: z.number().int().nonnegative(),
  newestUpdate: z.string().optional(),
});

export const FolderSummariesResponseSchema = z.object({
  summaries: z.record(z.string(), FolderSummarySchema),
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
  /** Whether the queue is paused (queued jobs wait; running ones finish) */
  paused: z.boolean(),
});

/** POST /api/folder/queue/pause | /resume */
export const QueuePauseResponseSchema = z.object({
  paused: z.boolean(),
});

/** DELETE /api/folder/queue/finished */
export const ClearFinishedResponseSchema = z.object({
  cleared: z.number(),
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

/**
 * One Server-Sent Event of POST /api/folder/download-video (consumed by the
 * Chrome extension). The server validates every event against this schema
 * before writing it to the stream and the extension parses the same schema
 * on the receiving end, so the two sides can never drift apart.
 */
export const downloadVideoEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('downloadStart'),
    videoTitle: z.string().optional(),
  }),
  z.object({
    type: z.literal('downloadProgress'),
    progress: z.number().optional(),
    message: z.string().optional(),
  }),
  z.object({
    type: z.literal('downloadComplete'),
    message: z.string().optional(),
  }),
  z.object({
    type: z.literal('downloadError'),
    error: z.string().optional(),
  }),
]);

/** Derived contract types (re-exported from api.ts) */
export type VideoComment = z.infer<typeof VideoCommentSchema>;
export type CommentWithReplies = z.infer<typeof CommentWithRepliesSchema>;
export type VideoListItem = z.infer<typeof VideoListItemSchema>;
export type ChannelsResponse = z.infer<typeof ChannelsResponseSchema>;
export type VideoDetails = z.infer<typeof VideoDetailsSchema>;
export type SubtitleTrack = z.infer<typeof SubtitleTrackSchema>;
export type SearchResponse = z.infer<typeof SearchResponseSchema>;
export type CategoriesResponse = z.infer<typeof CategoriesResponseSchema>;
export type VideoDetailsResponse = z.infer<typeof VideoDetailsResponseSchema>;
export type CommentsResponse = z.infer<typeof CommentsResponseSchema>;
export type VideoSummaryResponse = z.infer<typeof VideoSummaryResponseSchema>;
export type ReindexStatus = z.infer<typeof ReindexStatusSchema>;
export type RecreateIndicesStatus = z.infer<typeof RecreateIndicesStatusSchema>;
export type DownloadOptions = z.infer<typeof DownloadOptionsSchema>;
export type FolderConfig = z.infer<typeof FolderConfigSchema>;
export type StatusResponse = z.infer<typeof StatusResponseSchema>;
export type ChannelVideo = z.infer<typeof ChannelVideoSchema>;
export type FolderListResponse = z.infer<typeof FolderListResponseSchema>;
export type FolderSummary = z.infer<typeof FolderSummarySchema>;
export type FolderSummariesResponse = z.infer<typeof FolderSummariesResponseSchema>;
export type QueueJob = z.infer<typeof QueueJobSchema>;
export type SkippedVideo = z.infer<typeof SkippedVideoSchema>;
export type EnqueueJobsResponse = z.infer<typeof EnqueueJobsResponseSchema>;
export type QueueListResponse = z.infer<typeof QueueListResponseSchema>;
export type QueuePauseResponse = z.infer<typeof QueuePauseResponseSchema>;
export type ClearFinishedResponse = z.infer<typeof ClearFinishedResponseSchema>;
export type ListExistsResponse = z.infer<typeof ListExistsResponseSchema>;
export type VideoDownloadedResponse = z.infer<typeof VideoDownloadedResponseSchema>;
export type RebuildIndexResponse = z.infer<typeof RebuildIndexResponseSchema>;
export type DownloadPlaylistResponse = z.infer<typeof DownloadPlaylistResponseSchema>;
export type SaveFolderConfigResponse = z.infer<typeof SaveFolderConfigResponseSchema>;
export type DownloadVideoEvent = z.infer<typeof downloadVideoEventSchema>;
export type ApiError = z.infer<typeof ApiErrorSchema>;
