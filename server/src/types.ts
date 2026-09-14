import type { VideoComment } from '@shared/api';

/**
 * Server-only types. The HTTP contract (what the client sees) lives in
 * `shared/api.ts`; this file describes what the server reads from disk.
 */

/**
 * yt-dlp `.info.json` metadata file. The fields are the ones yt-dlp actually
 * writes (verified against real files from the configured folders); anything
 * else lands in the index signature.
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
  webpage_url_basename?: string;
  webpage_url_domain?: string;
  display_id?: string;
  extractor?: string;
  extractor_key?: string;
  epoch?: number;
  is_live?: boolean;
  was_live?: boolean;
  live_status?: string;
  availability?: string;
  age_limit?: number;
  playable_in_embed?: boolean;
  _type?: string;
  /** yt-dlp version that wrote the file, e.g. { version: '2026.08.19', ... } */
  _version?: Record<string, unknown>;
  _format_sort_fields?: string[];
  categories?: string[];
  tags?: string[];
  formats?: unknown[];
  automatic_captions?: Record<string, unknown[]>;
  subtitles?: Record<string, unknown[]>;
  /** yt-dlp writes many more fields than we model */
  [key: string]: unknown;
}
