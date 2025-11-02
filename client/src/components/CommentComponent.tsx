import { useState } from 'react';
import { Comment } from '../types';

const MAX_COMMENT_LENGTH = 250;

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
      day: 'numeric',
    });
  }
}

/**
 * Count replies (only one level of nesting supported)
 */
function countReplies(comment: Comment): number {
  if (!comment.replies || comment.replies.length === 0) {
    return 0;
  }
  return comment.replies.length;
}

interface CommentComponentProps {
  comment: Comment;
  depth?: number;
}

/**
 * Recursive component for rendering comments with nested replies
 */
export default function CommentComponent({ comment, depth = 0 }: CommentComponentProps) {
  const hasReplies = comment.replies && comment.replies.length > 0;
  const isReply = depth > 0;
  const [isExpanded, setIsExpanded] = useState(false);
  const [isRepliesExpanded, setIsRepliesExpanded] = useState(false); // Default to collapsed

  const commentText = comment.text || '';
  const isLong = commentText.length > MAX_COMMENT_LENGTH;
  const displayText =
    isLong && !isExpanded ? commentText.substring(0, MAX_COMMENT_LENGTH) + '...' : commentText;

  const totalRepliesCount = hasReplies ? countReplies(comment) : 0;

  return (
    <div
      className={`comment-item ${isReply ? 'comment-reply' : ''}`}
      style={{ marginLeft: `${depth * 1.5}rem` }}
    >
      <div className="comment-header">
        <strong>{comment.author || 'Anonymous'}</strong>
        {comment.like_count !== undefined && comment.like_count > 0 && (
          <span className="comment-likes">{comment.like_count} likes</span>
        )}
      </div>
      <p className="comment-text">
        {displayText}
        {isLong && (
          <button className="comment-expand-btn" onClick={() => setIsExpanded(!isExpanded)}>
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
        {!comment.timestamp &&
          !comment.time_parsed &&
          (comment.time_text || comment._time_text) && (
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
      {hasReplies && isRepliesExpanded && (
        <div className="comment-replies">
          {comment.replies!.map((reply, index) => (
            <CommentComponent
              key={reply.id || `reply-${index}`}
              comment={reply}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

