import type { JSX } from 'react';
import CommentComponent from './CommentComponent';
import type { CommentWithReplies } from '@shared/api';

interface VideoCommentsProps {
  comments: CommentWithReplies[];
  commentCount?: number;
}

export default function VideoComments({
  comments,
  commentCount,
}: VideoCommentsProps): JSX.Element | null {
  if (!comments || comments.length === 0) {
    return null;
  }

  return (
    <div className="video-comments-section">
      <h2>Komentarze {commentCount ? `(${commentCount})` : ''}</h2>

      <div className="comments-list">
        {comments
          .map((comment, index) => ({ comment, key: comment.id ?? `comment-${index}` }))
          .map(({ comment, key }) => (
            <CommentComponent key={key} comment={comment} />
          ))}
      </div>
    </div>
  );
}
