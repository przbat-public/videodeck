import type { CommentWithReplies } from '@videodeck/shared/api';
import { COMMENTS_PAGE_SIZE, CommentsResponseSchema } from '@videodeck/shared/schemas';
import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import CommentComponent from './CommentComponent';
import { Button } from './ui/Button';
import { ErrorMessage } from './ui/ErrorMessage';

interface VideoCommentsProps {
  videoId: string;
  /** First page, already part of the details payload */
  comments: CommentWithReplies[];
  /** Total top-level comments known to the server */
  commentCount?: number;
}

export default function VideoComments({ videoId, comments, commentCount }: VideoCommentsProps): JSX.Element | null {
  const { t } = useTranslation();
  const [items, setItems] = useState(comments);
  const [previousComments, setPreviousComments] = useState(comments);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState(false);
  /** One page at a time: a double click must not fire two fetches */
  const inFlightRef = useRef(false);
  /** Cancelled when a newer page starts or the component unmounts */
  const abortRef = useRef<AbortController | null>(null);

  // The details payload was replaced (identifier or subtitle state changed):
  // start over from its first page. Adjusted during render, not in an effect.
  if (comments !== previousComments) {
    setPreviousComments(comments);
    setItems(comments);
    setLoadError(false);
  }

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  if (items.length === 0) {
    return null;
  }

  const hasMore = commentCount !== undefined && items.length < commentCount;

  const loadMore = async (): Promise<void> => {
    if (inFlightRef.current) {
      return;
    }
    inFlightRef.current = true;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoadingMore(true);
    setLoadError(false);
    try {
      const response = await fetch(
        `/api/videos/${encodeURIComponent(videoId)}/comments?offset=${items.length}&limit=${COMMENTS_PAGE_SIZE}`,
        { signal: controller.signal },
      );
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const page = CommentsResponseSchema.parse(await response.json());
      setItems((current) => [...current, ...page.comments]);
    } catch {
      if (controller.signal.aborted) {
        return; // superseded by a newer page or an unmount — not an error
      }
      setLoadError(true);
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
      }
      inFlightRef.current = false;
      setLoadingMore(false);
    }
  };

  return (
    <div className="video-comments-section">
      <h2>
        {commentCount !== undefined ? t('video.commentsWithCount', { count: commentCount }) : t('video.comments')}
      </h2>

      <div className="comments-list">
        {items
          .map((comment, index) => ({ comment, key: comment.id ?? `comment-${index}` }))
          .map(({ comment, key }) => (
            <CommentComponent key={key} comment={comment} />
          ))}
      </div>

      {hasMore && (
        <Button onClick={() => void loadMore()} disabled={loadingMore}>
          {loadingMore ? t('app.loading') : t('video.showMoreComments', { shown: items.length, total: commentCount })}
        </Button>
      )}
      {loadError && <ErrorMessage compact>{t('video.commentsError')}</ErrorMessage>}
    </div>
  );
}
