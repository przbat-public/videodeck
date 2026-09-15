import { z } from 'zod';

/**
 * Zod schemas for the JSON bodies the folder endpoints accept. A failed
 * parse becomes a 400 with the first issue spelled out — replacing the
 * hand-rolled checks that used to live in the handlers.
 */

/** POST /api/folder/queue */
export const queueBodySchema = z.object({
  folderPath: z.string(),
  type: z.enum(['download', 'update']),
  videos: z
    .array(
      z.object({
        videoId: z.string().optional(),
        videoUrl: z.string().optional(),
        url: z.string().optional(),
        title: z.string().optional(),
      }),
    )
    .min(1, 'videos must be a non-empty array'),
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
