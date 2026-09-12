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
      <h2>Comments {commentCount ? `(${commentCount})` : ''}</h2>

      <div className="comments-list">
        {comments.map((comment, index) => (
          <CommentComponent key={comment.id || index} comment={comment} />
        ))}
      </div>
    </div>
  );
}
