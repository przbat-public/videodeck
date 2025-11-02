/**
 * Reconstructs nested comment structure from flat array.
 * Comments may be stored flat with 'parent' field instead of nested 'replies'.
 * 
 * @param comments - Array of comments (either flat with 'parent' field or already nested with 'replies')
 * @returns Array of root comments with nested replies, sorted by like_count (descending)
 */
export function buildCommentTree(comments: any[]): any[] {
  if (!comments || comments.length === 0) return [];

  // Check if comments already have nested structure
  const hasNestedReplies = comments.some((c: any) => c.replies && Array.isArray(c.replies));
  if (hasNestedReplies) {
    // Sort root comments by like_count (descending - most likes first)
    const sorted = [...comments].sort((a, b) => {
      const likesA = a.like_count || 0;
      const likesB = b.like_count || 0;
      return likesB - likesA;
    });
    return sorted;
  }

  // Build tree from flat structure using 'parent' field
  const commentMap = new Map<string, any>();
  const rootComments: any[] = [];

  // First pass: create map and prepare comments
  comments.forEach((comment: any) => {
    const processed = {
      ...comment,
      replies: [] as any[],
      reply_count: 0,
    };
    commentMap.set(comment.id, processed);
  });

  // Second pass: build tree structure
  comments.forEach((comment: any) => {
    const processed = commentMap.get(comment.id)!;

    if (comment.parent === 'root' || !comment.parent) {
      rootComments.push(processed);
    } else {
      const parent = commentMap.get(comment.parent);
      if (parent) {
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
}

