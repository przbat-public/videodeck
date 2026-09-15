import type { CommentWithReplies } from '@shared/api';
import type { TFunction } from 'i18next';
import type { JSX } from 'react';
import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';

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

/** Collapsed preview while the comment is long and folded, full text otherwise */
function displayCommentText(text: string, isLong: boolean, isExpanded: boolean): string {
  if (isLong && !isExpanded) {
    return `${text.substring(0, MAX_COMMENT_LENGTH)}...`;
  }
  return text;
}

interface CommentTimestampProps {
  comment: CommentWithReplies;
  formattedDate: string | null;
}

/** Formatted relative date, falling back to the raw yt-dlp time fields */
function CommentTimestamp({ comment, formattedDate }: CommentTimestampProps): JSX.Element | null {
  if (formattedDate !== null) {
    return (
      <span className="comment-time" title={formattedDate}>
        {formattedDate}
      </span>
    );
  }
  if (comment.time_parsed) {
    return <span className="comment-time">{comment.time_parsed}</span>;
  }
  const fallback = comment.time_text || comment._time_text;
  if (fallback) {
    return <span className="comment-time">{fallback}</span>;
  }
  return null;
}

interface CommentFooterProps {
  comment: CommentWithReplies;
  formattedDate: string | null;
  hasReplies: boolean;
  isRepliesExpanded: boolean;
  totalRepliesCount: number;
  onToggleReplies: () => void;
}

/** Timestamp plus the expand/collapse toggle for the reply thread */
function CommentFooter({
  comment,
  formattedDate,
  hasReplies,
  isRepliesExpanded,
  totalRepliesCount,
  onToggleReplies,
}: CommentFooterProps): JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="comment-footer">
      <CommentTimestamp comment={comment} formattedDate={formattedDate} />
      {hasReplies && (
        <button
          type="button"
          className="comment-replies-toggle"
          onClick={onToggleReplies}
          title={isRepliesExpanded ? t('video.collapseReplies') : t('video.showReplies')}
        >
          {isRepliesExpanded ? '▼' : '▶'}
          <span className="comment-replies-count">({t('video.replyCount', { count: totalRepliesCount })})</span>
        </button>
      )}
    </div>
  );
}

interface CommentRepliesListProps {
  replies: CommentWithReplies[];
  depth: number;
}

function CommentRepliesList({ replies, depth }: CommentRepliesListProps): JSX.Element {
  return (
    <div className="comment-replies">
      {replies
        .map((reply, index) => ({ reply, key: reply.id ?? `reply-${index}` }))
        .map(({ reply, key }) => (
          <CommentComponent key={key} comment={reply} depth={depth + 1} />
        ))}
    </div>
  );
}

interface CommentComponentProps {
  comment: CommentWithReplies;
  depth?: number;
}

/**
 * Recursive component for rendering comments with nested replies. Memoized:
 * loading another page re-renders the comments section, and without memo
 * every already-visible comment (a tree with dozens of nodes) would render
 * again — the comment objects are stable, so the shallow comparison skips
 * them. useTranslation still re-renders on a language switch.
 */
const CommentComponent = memo(function CommentComponent({ comment, depth = 0 }: CommentComponentProps): JSX.Element {
  const { t, i18n } = useTranslation();
  const hasReplies = (comment.replies?.length ?? 0) > 0;
  const isReply = depth > 0;
  const [isExpanded, setIsExpanded] = useState(false);
  const [isRepliesExpanded, setIsRepliesExpanded] = useState(false); // Default to collapsed

  const commentText = comment.text || '';
  const isLong = commentText.length > MAX_COMMENT_LENGTH;
  const displayText = displayCommentText(commentText, isLong, isExpanded);

  const totalRepliesCount = comment.replies?.length ?? 0;
  const formattedDate = comment.timestamp !== undefined ? formatCommentDate(comment.timestamp, i18n.language, t) : null;

  return (
    <div className={`comment-item ${isReply ? 'comment-reply' : ''}`} style={{ marginLeft: `${depth * 1.5}rem` }}>
      <div className="comment-header">
        <strong>{comment.author || t('video.commentAnonymous')}</strong>
        {(comment.like_count ?? 0) > 0 && (
          <span className="comment-likes">{t('video.commentLikes', { count: comment.like_count })}</span>
        )}
      </div>
      <p className="comment-text">
        {displayText}
        {isLong && (
          <button type="button" className="comment-expand-btn" onClick={() => setIsExpanded(!isExpanded)}>
            {isExpanded ? ` ${t('video.collapse')}` : ` ${t('video.readMore')}`}
          </button>
        )}
      </p>
      <CommentFooter
        comment={comment}
        formattedDate={formattedDate}
        hasReplies={hasReplies}
        isRepliesExpanded={isRepliesExpanded}
        totalRepliesCount={totalRepliesCount}
        onToggleReplies={() => setIsRepliesExpanded(!isRepliesExpanded)}
      />
      {isRepliesExpanded && hasReplies && <CommentRepliesList replies={comment.replies ?? []} depth={depth} />}
    </div>
  );
});

export default CommentComponent;
