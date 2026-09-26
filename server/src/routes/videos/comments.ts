import type { CommentsResponse } from '@videodeck/shared/api';
import { COMMENTS_PAGE_SIZE } from '@videodeck/shared/schemas';
import { loadCommentTree } from '../../services/commentStore';
import type { RouteHandler } from '../http';
import { readString } from '../http';
import { findVideo, parseNonNegativeInt, parseOffset } from './helpers';

/**
 * GET /api/videos/:identifier/comments.
 *
 * One page of the comment tree. The mtime-keyed cache in the comment store is
 * what keeps the details endpoint and this one from parsing the same huge
 * info.json twice.
 */

// GET /api/videos/:identifier/comments?offset=&limit= - one page of the
// comment tree; the same mtime-keyed cache as the details endpoint serves it
export const getComments: RouteHandler<{ identifier: string }, CommentsResponse> = async (req, res) => {
  const video = await findVideo(req.params.identifier);

  if (!video) {
    res.status(404).json({ error: 'Video not found' });
    return;
  }

  const tree = await loadCommentTree(video.folderPath, video.baseName);
  if (tree === null) {
    res.json({ comments: [], totalCount: 0, offset: 0 });
    return;
  }

  const offset = parseOffset(readString(req.query.offset));
  const limit = Math.min(500, Math.max(1, parseNonNegativeInt(readString(req.query.limit), COMMENTS_PAGE_SIZE)));

  res.json({ comments: tree.slice(offset, offset + limit), totalCount: tree.length, offset });
};
