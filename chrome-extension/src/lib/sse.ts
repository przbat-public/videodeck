import type { DownloadVideoEvent } from '@videodeck/shared/api';
import { downloadVideoEventSchema } from '@videodeck/shared/schemas';
import { parseSseEvent as parseWithSchema } from '@videodeck/shared/sse';

/**
 * The download stream's binding of the shared SSE framing in
 * `@videodeck/shared/sse`: one schema, one parser, and the same import the
 * service worker has always used.
 */

export type { SseFrame } from '@videodeck/shared/sse';
export { feedSseBuffer } from '@videodeck/shared/sse';

/** Parse one `data:` payload of the download stream; null for anything else */
export function parseSseEvent(raw: string): DownloadVideoEvent | null {
  return parseWithSchema(downloadVideoEventSchema, raw);
}
