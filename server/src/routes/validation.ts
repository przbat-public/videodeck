import { z } from 'zod';

/**
 * Zod schemas for the JSON bodies the folder endpoints accept. A failed
 * parse becomes a 400 with the first issue spelled out — replacing the
 * hand-rolled checks that used to live in the handlers.
 */

/**
 * Largest JSON body the server parses (1 MiB). The biggest legitimate one is
 * a bulk enqueue for a whole channel, `POST /api/folder/queue` with one
 * `{ videoId }` per video; body-parser's default of 100 kB is too small for
 * that.
 */
export const JSON_BODY_LIMIT_BYTES = 1024 * 1024;

/** `{"videoId":"<11 chars>"},`: the smallest entry the client sends */
const SMALLEST_QUEUE_ENTRY_BYTES = 26;

/**
 * The most videos one POST /api/folder/queue may name. A body that holds this
 * many real entries is already over the body limit, so the cap never refuses
 * a request the client can send. What it refuses is a body of tinier elements
 * (bare numbers, `{}`), and zod checks it before it walks them.
 */
export const MAX_QUEUE_VIDEOS = Math.ceil(JSON_BODY_LIMIT_BYTES / SMALLEST_QUEUE_ENTRY_BYTES);

/** POST /api/folder/queue */
export const queueBodySchema = z.object({
  folderPath: z.string(),
  type: z.enum(['download', 'update', 'repair']),
  videos: z
    .array(
      z.object({
        videoId: z.string().optional(),
        videoUrl: z.string().optional(),
        url: z.string().optional(),
        title: z.string().optional(),
        /** Repair jobs only: refresh the comment section as well */
        comments: z.boolean().optional(),
      }),
    )
    .min(1, 'videos must be a non-empty array')
    .max(MAX_QUEUE_VIDEOS, `videos must hold at most ${MAX_QUEUE_VIDEOS} entries`),
  /**
   * Queue a download even though the catalog or the folder's record says it
   * cannot arrive. Off by default: the checks behind it exist to spare the
   * console a wall of failures, not to forbid an operator who knows better.
   */
  force: z.boolean().optional(),
});

/** PUT /api/folder/config */
export const configBodySchema = z.object({
  folderPath: z.string(),
  config: z.record(z.string(), z.unknown()),
});

/** `path: message` of the first validation issue, for the 400 response */
export function firstZodError(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) {
    return 'Invalid request body';
  }
  const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
  return `${path}${issue.message}`;
}
