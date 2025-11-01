import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { VideoInfo } from '../hooks/useVideoSearch';

const MAX_COMMENT_LENGTH = 250;

/**
 * Comment structure with nested replies (recursive)
 */
interface Comment {
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

interface VideoDetails {
  title: string;
  description: string;
  uploadDate: string;
  duration: string;
  viewCount: number;
  likeCount: number;
  channel: string;
  comments: Comment[];
  commentCount: number;
}

/**
 * Format comment timestamp to readable date
 */
function formatCommentDate(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  
  // If less than 7 days, show relative time
  if (diffDays === 0) {
    return 'Today';
  } else if (diffDays === 1) {
    return 'Yesterday';
  } else if (diffDays < 7) {
    return `${diffDays} days ago`;
  } else if (diffDays < 30) {
    const weeks = Math.floor(diffDays / 7);
    return `${weeks} ${weeks === 1 ? 'week' : 'weeks'} ago`;
  } else if (diffDays < 365) {
    const months = Math.floor(diffDays / 30);
    return `${months} ${months === 1 ? 'month' : 'months'} ago`;
  } else {
    // For older comments, show full date
    return date.toLocaleDateString('en-US', { 
      year: 'numeric', 
      month: 'short', 
      day: 'numeric' 
    });
  }
}

/**
 * Count total nested comments (including replies to replies)
 */
function countAllReplies(comment: Comment): number {
  if (!comment.replies || comment.replies.length === 0) {
    return 0;
  }
  let count = comment.replies.length;
  comment.replies.forEach(reply => {
    count += countAllReplies(reply);
  });
  return count;
}

/**
 * Recursive component for rendering comments with nested replies
 */
function CommentComponent({ comment, depth = 0 }: { comment: Comment; depth?: number }) {
  const maxDepth = 5; // Prevent infinite nesting
  const hasReplies = comment.replies && comment.replies.length > 0;
  const isReply = depth > 0;
  const [isExpanded, setIsExpanded] = useState(false);
  const [isRepliesExpanded, setIsRepliesExpanded] = useState(false); // Default to collapsed
  
  const commentText = comment.text || '';
  const isLong = commentText.length > MAX_COMMENT_LENGTH;
  const displayText = isLong && !isExpanded 
    ? commentText.substring(0, MAX_COMMENT_LENGTH) + '...'
    : commentText;
  
  const totalRepliesCount = hasReplies ? countAllReplies(comment) : 0;

  return (
    <div className={`comment-item ${isReply ? 'comment-reply' : ''}`} style={{ marginLeft: `${depth * 1.5}rem` }}>
      <div className="comment-header">
        <strong>{comment.author || 'Anonymous'}</strong>
        {comment.like_count !== undefined && comment.like_count > 0 && (
          <span className="comment-likes">{comment.like_count} likes</span>
        )}
      </div>
      <p className="comment-text">
        {displayText}
        {isLong && (
          <button 
            className="comment-expand-btn"
            onClick={() => setIsExpanded(!isExpanded)}
          >
            {isExpanded ? ' Show less' : ' Read more'}
          </button>
        )}
      </p>
      <div className="comment-footer">
        {comment.timestamp && (
          <span className="comment-time" title={formatCommentDate(comment.timestamp)}>
            {formatCommentDate(comment.timestamp)}
          </span>
        )}
        {!comment.timestamp && comment.time_parsed && (
          <span className="comment-time">{comment.time_parsed}</span>
        )}
        {!comment.timestamp && !comment.time_parsed && (comment.time_text || comment._time_text) && (
          <span className="comment-time">{comment.time_text || comment._time_text}</span>
        )}
        {hasReplies && (
          <button 
            className="comment-replies-toggle"
            onClick={() => setIsRepliesExpanded(!isRepliesExpanded)}
            title={isRepliesExpanded ? 'Hide replies' : 'Show replies'}
          >
            {isRepliesExpanded ? '▼' : '▶'} 
            <span className="comment-replies-count">
              ({totalRepliesCount} {totalRepliesCount === 1 ? 'reply' : 'replies'})
            </span>
          </button>
        )}
      </div>
      
      {/* Render nested replies recursively */}
      {hasReplies && depth < maxDepth && isRepliesExpanded && (
        <div className="comment-replies">
          {comment.replies!.map((reply, index) => (
            <CommentComponent key={reply.id || `reply-${index}`} comment={reply} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function VideoDetail() {
  const { baseName } = useParams<{ baseName: string }>();
  const [video, setVideo] = useState<VideoInfo | null>(null);
  const [details, setDetails] = useState<VideoDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!baseName) {
      setError('Invalid video ID');
      setLoading(false);
      return;
    }

    const fetchData = async () => {
      try {
        setLoading(true);
        setError(null);

        // Find video in list
        const listResponse = await fetch('/api/videos/list');
        if (!listResponse.ok) throw new Error('Failed to load videos');
        const listData = await listResponse.json();
        const foundVideo = listData.videos.find((v: VideoInfo) => v.baseName === decodeURIComponent(baseName));
        
        if (!foundVideo) {
          throw new Error('Video not found');
        }
        setVideo(foundVideo);

        // Load details (including comments)
        const detailsResponse = await fetch(`/api/videos/${encodeURIComponent(foundVideo.baseName)}/details`);
        if (!detailsResponse.ok) throw new Error('Failed to load video details');
        const detailsData = await detailsResponse.json();
        setDetails(detailsData.details);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'An error occurred');
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [baseName]);

  if (loading) {
    return (
      <div className="video-detail-page">
        <div className="loading">
          <p>Loading video...</p>
        </div>
      </div>
    );
  }

  if (error || !video) {
    return (
      <div className="video-detail-page">
        <div className="error-message">
          <p>Error: {error || 'Video not found'}</p>
          <Link to="/" className="back-link">← Back to search</Link>
        </div>
      </div>
    );
  }

  const videoUrl = `/api/videos/file/${encodeURIComponent(video.videoPath)}`;
  const formatDate = (dateStr: string) => {
    if (!dateStr || dateStr.length !== 8) return dateStr;
    return `${dateStr.substring(0, 4)}-${dateStr.substring(4, 6)}-${dateStr.substring(6, 8)}`;
  };

  return (
    <div className="video-detail-page">
      <div className="video-detail-header">
        <Link to="/" className="back-link">← Back to search</Link>
      </div>

      <div className="video-detail-container">
        <div className="video-detail-main">
          <div className="video-player-section">
            <video
              src={videoUrl}
              controls
              autoPlay
              className="video-player-full"
            >
              Your browser does not support the video tag.
            </video>
          </div>

          <div className="video-detail-info">
            <h1>{details?.title || video.name}</h1>
            
            {details && (
              <div className="video-meta">
                <span>{details.channel}</span>
                {details.viewCount > 0 && <span>{details.viewCount.toLocaleString()} views</span>}
                {details.likeCount > 0 && <span>{details.likeCount.toLocaleString()} likes</span>}
                {details.uploadDate && <span>{formatDate(details.uploadDate)}</span>}
                {details.duration && <span>{details.duration}</span>}
              </div>
            )}

            <div className="video-description-full">
              <h2>Description</h2>
              <p>{details?.description || video.description}</p>
            </div>
          </div>
        </div>

        <div className="video-comments-section">
          <h2>Comments {details?.commentCount ? `(${details.commentCount})` : ''}</h2>
          
          {details?.comments && details.comments.length > 0 ? (
            <div className="comments-list">
              {details.comments.map((comment, index) => (
                <CommentComponent key={comment.id || index} comment={comment} />
              ))}
            </div>
          ) : (
            <p className="no-comments">No comments available.</p>
          )}
        </div>
      </div>
    </div>
  );
}

