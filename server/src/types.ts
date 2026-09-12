import type { VideoComment } from '@shared/api';

/**
 * Server-only types. The HTTP contract (what the client sees) lives in
 * `shared/api.ts`; this file describes what the server reads from disk.
 */

/**
 * yt-dlp `.info.json` metadata file.
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
  /** yt-dlp writes many more fields than we model */
  [key: string]: unknown;
}
