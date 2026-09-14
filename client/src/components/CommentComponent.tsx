import { useState } from 'react';
import type { JSX } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { CommentWithReplies } from '@shared/api';

const MAX_COMMENT_LENGTH = 250;

/**
 * "Dzisiaj"/"wczoraj"/"5 dni temu"… — relative dates with Intl in the
 * current UI language (skill react-i18n: never hand-roll dates).
 */
function formatCommentDate(timestamp: number, language: string, t: TFunction): string {
  const date = new Date(timestamp * 1000);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) {
    return t('video.commentToday');
  } else if (diffDays === 1) {
    return t('video.commentYesterday');
  } else if (diffDays < 7) {
    return t('video.commentDaysAgo', { count: diffDays });
  } else if (diffDays < 30) {
    const weeks = Math.floor(diffDays / 7);
    return t('video.commentWeeksAgo', { count: weeks });
  } else if (diffDays < 365) {
    const months = Math.floor(diffDays / 30);
    return t('video.commentMonthsAgo', { count: months });
  } else {
    return new Intl.DateTimeFormat(language, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    }).format(date);
  }
}

interface CommentComponentProps {
  comment: CommentWithReplies;
  depth?: number;
}

/**
 * Recursive component for rendering comments with nested replies
 */
export default function CommentComponent({
  comment,
  depth = 0,
}: CommentComponentProps): JSX.Element {
  const { t, i18n } = useTranslation();
  const hasReplies = comment.replies && comment.replies.length > 0;
  const isReply = depth > 0;
  const [isExpanded, setIsExpanded] = useState(false);
  const [isRepliesExpanded, setIsRepliesExpanded] = useState(false); // Default to collapsed

  const commentText = comment.text || '';
  const isLong = commentText.length > MAX_COMMENT_LENGTH;
  const displayText =
    isLong && !isExpanded ? commentText.substring(0, MAX_COMMENT_LENGTH) + '...' : commentText;

  const totalRepliesCount = hasReplies ? (comment.replies?.length ?? 0) : 0;
  const replies = comment.replies;
  const formattedDate =
    comment.timestamp !== undefined ? formatCommentDate(comment.timestamp, i18n.language, t) : null;

  return (
    <div
      className={`comment-item ${isReply ? 'comment-reply' : ''}`}
      style={{ marginLeft: `${depth * 1.5}rem` }}
    >
      <div className="comment-header">
        <strong>{comment.author || t('video.commentAnonymous')}</strong>
        {comment.like_count !== undefined && comment.like_count > 0 && (
          <span className="comment-likes">
            {t('video.commentLikes', { count: comment.like_count })}
          </span>
        )}
      </div>
      <p className="comment-text">
        {displayText}
        {isLong && (
          <button className="comment-expand-btn" onClick={() => setIsExpanded(!isExpanded)}>
            {isExpanded ? ` ${t('video.collapse')}` : ` ${t('video.readMore')}`}
          </button>
        )}
      </p>
      <div className="comment-footer">
        {formattedDate !== null && (
          <span className="comment-time" title={formattedDate}>
            {formattedDate}
          </span>
        )}
        {formattedDate === null && comment.time_parsed && (
          <span className="comment-time">{comment.time_parsed}</span>
        )}
        {formattedDate === null &&
          !comment.time_parsed &&
          (comment.time_text || comment._time_text) && (
            <span className="comment-time">{comment.time_text || comment._time_text}</span>
          )}
        {hasReplies && (
          <button
            className="comment-replies-toggle"
            onClick={() => setIsRepliesExpanded(!isRepliesExpanded)}
            title={isRepliesExpanded ? t('video.collapseReplies') : t('video.showReplies')}
          >
            {isRepliesExpanded ? '▼' : '▶'}
            <span className="comment-replies-count">
              ({t('video.replyCount', { count: totalRepliesCount })})
            </span>
          </button>
        )}
      </div>
      {hasReplies && isRepliesExpanded && replies && (
        <div className="comment-replies">
          {replies
            .map((reply, index) => ({ reply, key: reply.id ?? `reply-${index}` }))
            .map(({ reply, key }) => (
              <CommentComponent key={key} comment={reply} depth={depth + 1} />
            ))}
        </div>
      )}
    </div>
  );
}
