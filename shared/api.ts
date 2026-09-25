/**
 * HTTP API contract shared by the server (Express), the client (React) and
 * the Chrome extension (SSE events of POST /api/folder/download-video).
 *
 * Response types are DERIVED from the zod schemas in `shared/schemas.ts` and
 * re-exported here; request/event shapes that the server parses itself stay
 * hand-written below. This module still contains types only — `import type`
 * is enforced by ESLint.
 *
 * Optional properties are *absent* when the server has no value for them;
 * JSON has no `undefined`.
 */

import type { ApiError, FolderConfig, QueueJob, QueueSummaryResponse, ReindexStatus } from './schemas';

export type {
  ApiError,
  CategoriesResponse,
  ChannelsResponse,
  ChannelVideo,
  ClearFinishedResponse,
  CommentsResponse,
  CommentWithReplies,
  DownloadOptions,
  DownloadPlaylistResponse,
  DownloadVideoEvent,
  EnqueueJobsResponse,
  FolderConfig,
  FolderListResponse,
  FolderSummariesResponse,
  FolderSummary,
  HealthResponse,
  ListExistsResponse,
  QueueCounts,
  QueueFolderCounts,
  QueueJob,
  QueueJobResponse,
  QueueListJob,
  QueueListResponse,
  QueuePauseResponse,
  QueueSummaryResponse,
  RebuildIndexResponse,
  RecreateIndicesStatus,
  ReindexStatus,
  SaveFolderConfigResponse,
  SearchResponse,
  SkippedVideo,
  StatusResponse,
  SubtitleTrack,
  VideoComment,
  VideoDetails,
  VideoDetailsResponse,
  VideoDownloadedResponse,
  VideoListItem,
  VideoSummaryResponse,
} from './schemas';

// ---------------------------------------------------------------------------
// Common
// ---------------------------------------------------------------------------

/** Body of fire-and-forget endpoints that only acknowledge the request */
export interface AcceptedResponse {
  message: string;
  status: 'ok';
}

// ---------------------------------------------------------------------------
// Videos — /api/videos
// ---------------------------------------------------------------------------

export type SortOption =
  | 'relevance'
  | 'date-desc'
  | 'date-asc'
  | 'views-desc'
  | 'views-asc'
  | 'likes-desc'
  | 'likes-asc';

/** 409 body of GET /api/videos/refreshCache while a reindex is running */
export interface ReindexConflictResponse extends ApiError {
  status: ReindexStatus;
}

// ---------------------------------------------------------------------------
// Folders — /api/folder
// ---------------------------------------------------------------------------

/** Body of requests that only identify a folder */
export interface FolderPathRequest {
  folderPath: string;
}

/** PUT /api/folder/config */
export interface SaveFolderConfigRequest extends FolderPathRequest {
  config: FolderConfig;
}

/** One video to enqueue; `videoId` is derived from the URL when missing */
export interface QueueVideoInput {
  videoId?: string;
  videoUrl?: string;
  /** Alias of `videoUrl` (list.json entries use `url`) */
  url?: string;
  title?: string;
}

/** POST /api/folder/queue */
export interface EnqueueJobsRequest extends FolderPathRequest {
  type: JobType;
  videos: QueueVideoInput[];
}

// ---------------------------------------------------------------------------
// Download queue — /api/folder/queue
// ---------------------------------------------------------------------------

export type JobType = 'download' | 'update';
export type JobStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled';

/**
 * GET /api/folder/queue/summaries without the paused flag: what the queue
 * itself can answer, and what the route turns into the response body.
 */
export type QueueSummary = Omit<QueueSummaryResponse, 'paused'>;

/** DELETE /api/folder/queue?folderPath= */
export interface CancelAllResponse {
  cancelled: number;
}

/** DELETE /api/folder/queue/:jobId */
export interface CancelJobResponse {
  cancelled: boolean;
  job?: QueueJob;
}

/** POST /api/folder/download-video (body) */
export interface DownloadVideoRequest extends FolderPathRequest {
  videoUrl: string;
}

// The SSE events of POST /api/folder/download-video (`DownloadVideoEvent`)
// are schema-derived too: see downloadVideoEventSchema in shared/schemas.ts
// and the re-export at the top of this file.
