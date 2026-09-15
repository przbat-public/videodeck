import type { CommentWithReplies, VideoComment } from '@shared/api';

/** Sort by like_count descending (most likes first) */
function sortByLikes(comments: CommentWithReplies[]): CommentWithReplies[] {
  return [...comments].sort((a, b) => (b.like_count || 0) - (a.like_count || 0));
}

/**
 * Link one flat comment to its parent's replies. Comments with
 * `parent: 'root'` (or no parent) and orphans become root comments.
 */
function attachComment(
  comment: VideoComment | CommentWithReplies,
  commentMap: Map<string, CommentWithReplies>,
  rootComments: CommentWithReplies[],
): void {
  if (!comment.id) {
    return; // Skip comments without id
  }
  const processed = commentMap.get(comment.id);
  if (!processed) {
    return;
  }
  const parentId = comment.parent;
  if (parentId === 'root' || !parentId) {
    rootComments.push(processed);
    return;
  }
  if (typeof parentId !== 'string') {
    return;
  }
  const parent = commentMap.get(parentId);
  if (!parent) {
    // Orphaned reply, treat as root comment
    rootComments.push(processed);
    return;
  }
  if (!parent.replies) {
    parent.replies = [];
  }
  parent.replies.push(processed);
  parent.reply_count = (parent.reply_count || 0) + 1;
}

/**
 * Reconstructs nested comment structure from flat array.
 * Comments may be stored flat with 'parent' field instead of nested 'replies'.
 *
 * @param comments - Array of comments (either flat with 'parent' field or already nested with 'replies')
 * @returns Array of root comments with nested replies, sorted by like_count (descending)
 */
export const buildCommentTree = (comments: (VideoComment | CommentWithReplies)[]): CommentWithReplies[] => {
  if (!comments || comments.length === 0) return [];

  // Comments that already carry a nested structure only need sorting
  const hasNestedReplies = comments.some((c) => 'replies' in c && Array.isArray(c.replies));
  if (hasNestedReplies) {
    return sortByLikes(comments as CommentWithReplies[]);
  }

  // Build tree from flat structure using the 'parent' field
  const commentMap = new Map<string, CommentWithReplies>();
  const rootComments: CommentWithReplies[] = [];

  // First pass: create an entry for every comment that has an id
  for (const comment of comments) {
    if (!comment.id) {
      continue; // Skip comments without id
    }
    commentMap.set(comment.id, {
      ...comment,
      replies: [],
      reply_count: 0,
    });
  }

  // Second pass: attach every comment to its parent (or the root list)
  for (const comment of comments) {
    attachComment(comment, commentMap, rootComments);
  }

  return sortByLikes(rootComments);
};
