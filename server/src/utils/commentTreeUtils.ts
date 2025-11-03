import { VideoComment, CommentWithReplies } from '../types';

/**
 * Reconstructs nested comment structure from flat array.
 * Comments may be stored flat with 'parent' field instead of nested 'replies'.
 * 
 * @param comments - Array of comments (either flat with 'parent' field or already nested with 'replies')
 * @returns Array of root comments with nested replies, sorted by like_count (descending)
 */
export const buildCommentTree = (comments: (VideoComment | CommentWithReplies)[]): CommentWithReplies[] => {
  if (!comments || comments.length === 0) return [];

  // Check if comments already have nested structure
  const hasNestedReplies = comments.some((c) => 'replies' in c && c.replies && Array.isArray(c.replies));
  if (hasNestedReplies) {
    // Sort root comments by like_count (descending - most likes first)
    const sorted = [...comments].sort((a, b) => {
      const likesA = a.like_count || 0;
      const likesB = b.like_count || 0;
      return likesB - likesA;
    });
    return sorted as CommentWithReplies[];
  }

  // Build tree from flat structure using 'parent' field
  const commentMap = new Map<string, CommentWithReplies>();
  const rootComments: CommentWithReplies[] = [];

  // First pass: create map and prepare comments
  comments.forEach((comment) => {
    if (!comment.id) return; // Skip comments without id
    
    const processed: CommentWithReplies = {
      ...comment,
      replies: [],
      reply_count: 0,
    };
    commentMap.set(comment.id, processed);
  });

  // Second pass: build tree structure
  comments.forEach((comment) => {
    if (!comment.id) return; // Skip comments without id
    
    const processed = commentMap.get(comment.id);
    if (!processed) return;

    const parentId = comment.parent;
    if (parentId === 'root' || !parentId) {
      rootComments.push(processed);
    } else if (typeof parentId === 'string') {
      const parent = commentMap.get(parentId);
      if (parent) {
        if (!parent.replies) {
          parent.replies = [];
        }
        parent.replies.push(processed);
        parent.reply_count = (parent.reply_count || 0) + 1;
      } else {
        // Orphaned reply, treat as root comment
        rootComments.push(processed);
      }
    }
  });

  // Sort root comments by like_count (descending - most likes first)
  rootComments.sort((a, b) => {
    const likesA = a.like_count || 0;
    const likesB = b.like_count || 0;
    return likesB - likesA;
  });

  return rootComments;
};

