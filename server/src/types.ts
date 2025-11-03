/**
 * Video information structure
 */
export interface VideoListItem {
  baseName: string;
  title: string;
  description: string;
  videoPath: string;
  thumbnailPath: string;
  folderPath: string; // Path to the folder containing this video
  uploadDate?: string;
  viewCount?: number;
  likeCount?: number;
  channelName?: string;
  comments: VideoComment[];
}

export type SortOption =
  | 'date-desc'
  | 'date-asc'
  | 'views-desc'
  | 'views-asc'
  | 'likes-desc'
  | 'likes-asc';

/**
 * Comment structure from yt-dlp info.json
 */
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

/**
 * Type for yt-dlp info.json file structure
 * This represents the metadata file downloaded by yt-dlp
 */
export interface VideoInfoJson {
  id?: string;
  title?: string;
  fulltitle?: string;
  description?: string;
  channel?: string;
  channel_id?: string;
  channel_url?: string;
  channel_follower_count?: number;
  uploader?: string;
  uploader_id?: string;
  uploader_url?: string;
  upload_date?: string;
  timestamp?: number;
  duration?: number;
  duration_string?: string;
  view_count?: number;
  like_count?: number;
  comment_count?: number;
  comments?: VideoComment[];
  thumbnail?: string;
  thumbnails?: Array<{
    url?: string;
    width?: number;
    height?: number;
  }>;
  webpage_url?: string;
  formats?: unknown[];
  categories?: string[];
  tags?: string[];
  availability?: string;
  live_status?: string;
  media_type?: string;
  age_limit?: number;
  playable_in_embed?: boolean;
  automatic_captions?: Record<string, unknown[]>;
  subtitles?: Record<string, unknown[]>;
  [key: string]: unknown; // Allow additional fields from yt-dlp
}

/**
 * Comment structure with nested replies (recursive)
 * Used for building comment trees from flat comment arrays
 */
export interface CommentWithReplies {
  id?: string;
  author?: string;
  author_id?: string;
  text?: string;
  like_count?: number;
  timestamp?: number;
  time_text?: string;
  _time_text?: string;
  is_favorited?: boolean;
  author_thumbnail?: string;
  author_is_uploader?: boolean;
  replies?: CommentWithReplies[];
  reply_count?: number;
  [key: string]: unknown;
}

/**
 * Video details structure returned by the API
 */
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
}
