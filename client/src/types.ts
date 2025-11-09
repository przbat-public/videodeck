/**
 * Comment structure with nested replies (recursive)
 */
export interface Comment {
  id?: string;
  author?: string;
  author_id?: string;
  text?: string;
  like_count?: number;
  timestamp?: number;
  time_parsed?: string;
  time_text?: string;
  _time_text?: string; // Alternative time text field from yt-dlp
  is_favorited?: boolean;
  author_thumbnail?: string;
  author_is_uploader?: boolean;
  parent?: string;
  replies?: Comment[]; // Nested replies (recursive structure)
  reply_count?: number;
}

export interface VideoListItem {
  baseName: string;
  videoId?: string; // YouTube video ID
  title: string;
  description: string;
  videoPath: string;
  thumbnailPath: string;
  folderPath: string; // Path to the folder containing this video
  uploadDate?: string;
  viewCount?: number;
  likeCount?: number;
  channelName?: string; 
}

export interface VideoDetails {
  title: string;
  description: string;
  uploadDate: string;
  duration: string;
  viewCount: number;
  likeCount: number;
  channelName: string;
  comments: Comment[];
  commentCount: number;
  videoPath: string;
  thumbnailPath: string;
  subtitlePath?: string;
}

