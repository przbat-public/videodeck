/**
 * HTTP API contract shared by the server (Express), the client (React) and
 * the Chrome extension (SSE events of POST /api/folder/download-video).
 *
 * Types only — this module must never contain runtime code. All consumers
 * import it with `import type … from '@shared/api'` (enforced by ESLint), so
 * nothing from here lands in a bundle, a `node dist/…` run or an esbuild
 * output, and no project needs a path alias at runtime. Optional properties
 * are *absent* when the server has no value for them; JSON has no `undefined`.
 */

// ---------------------------------------------------------------------------
// Common
// ---------------------------------------------------------------------------

/** Body of every 4xx/5xx response */
export interface ApiError {
  error: string;
  message?: string;
}

/** Body of fire-and-forget endpoints that only acknowledge the request */
export interface AcceptedResponse {
  message: string;
  status: 'ok';
}

// ---------------------------------------------------------------------------
// Videos — /api/videos
// ---------------------------------------------------------------------------

export type SortOption =
  'relevance' | 'date-desc' | 'date-asc' | 'views-desc' | 'views-asc' | 'likes-desc' | 'likes-asc';

/** Flat comment as yt-dlp writes it into info.json (`parent` links replies) */
export interface VideoComment {
  id: string;
  parent?: string | 'root';
  text: string;
  like_count?: number;
  author_id?: string;
  author?: string;
  author_thumbnail?: string;
  author_is_uploader?: boolean;
  author_is_verified?: boolean;
  author_url?: string;
  is_favorited?: boolean;
  _time_text?: string;
  timestamp?: number;
  is_pinned?: boolean;
}

/** Comment tree node: a flat comment plus its nested replies */
export interface CommentWithReplies {
  id?: string;
  author?: string;
  author_id?: string;
  text?: string;
  like_count?: number;
  timestamp?: number;
  time_parsed?: string;
  time_text?: string;
  _time_text?: string;
  is_favorited?: boolean;
  author_thumbnail?: string;
  author_is_uploader?: boolean;
  parent?: string;
  replies?: CommentWithReplies[];
  reply_count?: number;
  /** yt-dlp adds fields we do not model; they are passed through untouched */
  [key: string]: unknown;
}

/** One indexed video, as returned by search */
export interface VideoListItem {
  /** File stem shared by the video and its sidecar files */
  baseName: string;
  /** YouTube video id */
  videoId?: string;
  title: string;
  description: string;
  /** File name of the video inside `folderPath` */
  videoPath: string;
  thumbnailPath: string;
  /** Folder the files live in — pass as `?folder=` to /api/videos/file */
  folderPath: string;
  /** YYYYMMDD */
  uploadDate?: string;
  viewCount?: number;
  likeCount?: number;
  channelName?: string;
  /** Always empty in search results (comments are indexed as text only) */
  comments: VideoComment[];
  subtitlePath?: string;
  /**
   * Cleaned subtitle text, search-only: indexed as a text field but stripped
   * from every response (like comments). Never sent to clients.
   */
  transcriptText?: string;
}

export interface VideoDetails {
  title: string;
  description: string;
  uploadDate: string;
  duration: string;
  viewCount: number;
  likeCount: number;
  channelName: string;
  comments: CommentWithReplies[];
  commentCount: number;
  videoPath: string;
  thumbnailPath: string;
  subtitlePath?: string;
  /** Folder the files live in — pass as `?folder=` to /api/videos/file */
  folderPath: string;
}

/** GET /api/videos/search?q=&sort=&category= */
export interface SearchResponse {
  videos: VideoListItem[];
  /** Videos indexed in the searched scope (the whole category when filtered) */
  totalCount: number;
}

/** GET /api/videos/categories — every category set in a folder's config.json */
export interface CategoriesResponse {
  categories: string[];
}

/** GET /api/videos/:identifier/details */
export interface VideoDetailsResponse {
  details: VideoDetails;
}

/** GET /api/videos/:identifier/summary */
export interface VideoSummaryResponse {
  summary: string;
  /** Present only when the subtitles were cut to fit the model's token limit */
  truncated?: true;
}

/** Progress of the running (or last finished) Elasticsearch reindex */
export interface ReindexStatus {
  running: boolean;
  startedAt?: string;
  finishedAt?: string;
  currentFolder?: string;
  foldersDone: number;
  foldersTotal: number;
  /** Progress inside the current folder */
  filesDone: number;
  filesTotal: number;
  /** Totals for the whole run */
  indexed: number;
  skipped: number;
  errors: string[];
  lastError?: string;
}

/** 409 body of GET /api/videos/refreshCache while a reindex is running */
export interface ReindexConflictResponse extends ApiError {
  status: ReindexStatus;
}

// ---------------------------------------------------------------------------
// Folders — /api/folder
// ---------------------------------------------------------------------------

/** yt-dlp options that can be set per folder in config.json */
export interface DownloadOptions {
  /** Maximum video height in pixels (e.g. 1080, 2160) */
  maxHeight: number;
  /** yt-dlp `--sub-lang` entries; empty array disables subtitle download */
  subLangs: string[];
  /** Pass `--write-comments` (comments are indexed for search) */
  writeComments: boolean;
}

/** Per-folder `config.json` */
export interface FolderConfig extends Partial<DownloadOptions> {
  channelUrl?: string;
  /**
   * Topic the channel belongs to, used to narrow search to a subset of
   * folders. Free-form and matched case-insensitively; never derived from the
   * folder name.
   */
  category?: string;
  /** Other keys are preserved as-is */
  [key: string]: unknown;
}

/** GET /api/folder/status */
export interface StatusResponse {
  videosFolderPath: string[];
  folderConfigs: Record<string, FolderConfig | null>;
  downloadDefaults: DownloadOptions;
  status: 'ok';
}

/** Body of requests that only identify a folder */
export interface FolderPathRequest {
  folderPath: string;
}

/** PUT /api/folder/config */
export interface SaveFolderConfigRequest extends FolderPathRequest {
  config: FolderConfig;
}

export interface SaveFolderConfigResponse {
  success: true;
  config: FolderConfig;
}

/** GET /api/folder/list-exists?folderPath= */
export interface ListExistsResponse {
  exists: boolean;
}

/** One entry of a channel's list.json (`yt-dlp --flat-playlist -j`) */
export interface ChannelVideo {
  title: string;
  url: string;
  id: string;
}

/** GET /api/folder/list?folderPath= */
export interface FolderListResponse {
  videos: ChannelVideo[];
  /** videoId → downloaded */
  downloadStatuses: Record<string, boolean>;
  /** videoId → ISO mtime of the info.json */
  lastUpdatedDates: Record<string, string>;
}

/** POST /api/folder/rebuild-index */
export interface RebuildIndexResponse {
  success: true;
  count: number;
  builtAt: string;
}

/** POST /api/folder/download-playlist */
export interface DownloadPlaylistResponse {
  success: true;
  message: string;
  listPath: string;
  videoCount: number;
}

/** GET /api/folder/video-downloaded?folderPath=&videoId= */
export interface VideoDownloadedResponse {
  downloaded: boolean;
}

// ---------------------------------------------------------------------------
// Download queue — /api/folder/queue
// ---------------------------------------------------------------------------

export type JobType = 'download' | 'update';
export type JobStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled';

export interface QueueJob {
  id: string;
  folderPath: string;
  videoId: string;
  videoUrl: string;
  title?: string;
  type: JobType;
  /** Existing file stem — required for `update` jobs */
  baseName?: string;
  /** Per-folder yt-dlp options (from config.json); defaults when absent */
  options?: DownloadOptions;
  status: JobStatus;
  /** 0-100 parsed from yt-dlp `[download]` lines, when available */
  progress?: number;
  /** Tail of yt-dlp output */
  log: string[];
  /** Total number of log lines ever appended (log itself is a bounded tail) */
  logLineCount: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  exitCode?: number | null;
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

export interface SkippedVideo {
  videoId: string;
  reason: string;
}

/** 202 body of POST /api/folder/queue */
export interface EnqueueJobsResponse {
  jobs: QueueJob[];
  skipped: SkippedVideo[];
}

/** GET /api/folder/queue?folderPath= */
export interface QueueListResponse {
  jobs: QueueJob[];
}

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

/** Server-sent events streamed by POST /api/folder/download-video (consumed by the Chrome extension) */
export type DownloadVideoEvent =
  | { type: 'start'; message: string }
  | { type: 'output'; message: string }
  | { type: 'done'; message: string; done: true }
  | { type: 'error'; error: string; done: true };
