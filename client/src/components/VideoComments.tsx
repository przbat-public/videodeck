import { useState } from 'react';
import type { JSX } from 'react';
import CommentComponent from './CommentComponent';
import { Button } from './ui/Button';
import { ErrorMessage } from './ui/ErrorMessage';
import type { CommentWithReplies } from '@shared/api';
import { CommentsResponseSchema } from '@shared/schemas';

interface VideoCommentsProps {
  videoId: string;
  /** First page, already part of the details payload */
  comments: CommentWithReplies[];
  /** Total top-level comments known to the server */
  commentCount?: number;
}

const COMMENTS_PAGE_SIZE = 50;

export default function VideoComments({
  videoId,
  comments,
  commentCount,
}: VideoCommentsProps): JSX.Element | null {
  const [items, setItems] = useState(comments);
  const [previousComments, setPreviousComments] = useState(comments);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState(false);

  // The details payload was replaced (identifier or subtitle state changed):
  // start over from its first page. Adjusted during render, not in an effect.
  if (comments !== previousComments) {
    setPreviousComments(comments);
    setItems(comments);
    setLoadError(false);
  }

  if (items.length === 0) {
    return null;
  }

  const hasMore = commentCount !== undefined && items.length < commentCount;

  const loadMore = async (): Promise<void> => {
    setLoadingMore(true);
    setLoadError(false);
    try {
      const response = await fetch(
        `/api/videos/${encodeURIComponent(videoId)}/comments?offset=${items.length}&limit=${COMMENTS_PAGE_SIZE}`
      );
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const page = CommentsResponseSchema.parse(await response.json());
      setItems((current) => [...current, ...page.comments]);
    } catch (error) {
      console.error('Error loading comments:', error);
      setLoadError(true);
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="video-comments-section">
      <h2>Komentarze {commentCount !== undefined ? `(${commentCount})` : ''}</h2>

      <div className="comments-list">
        {items
          .map((comment, index) => ({ comment, key: comment.id ?? `comment-${index}` }))
          .map(({ comment, key }) => (
            <CommentComponent key={key} comment={comment} />
          ))}
      </div>

      {hasMore && (
        <Button onClick={() => void loadMore()} disabled={loadingMore}>
          {loadingMore
            ? 'Ładowanie...'
            : `Pokaż więcej komentarzy (${items.length}/${commentCount})`}
        </Button>
      )}
      {loadError && (
        <ErrorMessage compact>Nie udało się załadować kolejnych komentarzy.</ErrorMessage>
      )}
    </div>
  );
}
