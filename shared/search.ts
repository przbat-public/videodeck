import type { SortOption } from './api';

/**
 * The sort a search takes when nobody picked one, shared by the client's URL
 * state and the server's request parsing so the two cannot drift apart.
 *
 * A typed phrase ranks by relevance: newest first put a video that shared one
 * common word with the phrase, somewhere in its comments, above the video the
 * phrase named in its title. Without a phrase every video matches alike, and
 * the library lists the newest first.
 */
export function defaultSortFor(query: string | undefined): SortOption {
  return (query ?? '').trim().length > 0 ? 'relevance' : 'date-desc';
}
