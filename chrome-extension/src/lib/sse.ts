import type { DownloadVideoEvent } from '@videodeck/shared/api';
import { downloadVideoEventSchema } from '@videodeck/shared/schemas';

/**
 * Minimal Server-Sent Events framing for the `POST /api/folder/download-video`
 * stream: every event is one `data: <json>\n\n` block. SSE comment lines
 * (`: ping` heartbeats from the server) carry no event and are ignored. The
 * event payload is validated with the zod schema shared with the server
 * (`downloadVideoEventSchema` in `shared/schemas.ts`).
 */

/** Result of appending one decoded chunk to the pending buffer */
export interface SseFrame {
  /** JSON payloads of the complete `data:` lines found in the chunk */
  events: string[];
  /** Incomplete trailing line, to be prepended to the next chunk */
  buffer: string;
}

/** Append a decoded chunk to the pending buffer and split off whole lines. */
export function feedSseBuffer(buffer: string, chunk: string): SseFrame {
  const lines = `${buffer}${chunk}`.split('\n');
  const rest = lines.pop() ?? '';
  // Only `data:` lines carry events; comment lines (`: ping`) and anything
  // else are dropped here.
  const events = lines.filter((line) => line.startsWith('data: ')).map((line) => line.slice('data: '.length));
  return { events, buffer: rest };
}

/** Parse one `data:` payload into a typed event; null for anything malformed. */
export function parseSseEvent(raw: string): DownloadVideoEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = downloadVideoEventSchema.safeParse(parsed);
  return result.success ? result.data : null;
}
