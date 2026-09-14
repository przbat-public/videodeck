import type { DownloadVideoEvent } from '@shared/api';

/**
 * Minimal Server-Sent Events framing for the `POST /api/folder/download-video`
 * stream: every event is one `data: <json>\n\n` block. The event payload type
 * (`DownloadVideoEvent`) is shared with the server via `shared/api.ts`.
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
  const events = lines
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice('data: '.length));
  return { events, buffer: rest };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

/** Parse one `data:` payload into a typed event; null for anything malformed. */
export function parseSseEvent(raw: string): DownloadVideoEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const record = asRecord(parsed);
  if (record === null) {
    return null;
  }

  const message = readStringField(record, 'message');
  switch (record.type) {
    case 'start':
      return { type: 'start', message: message ?? '' };
    case 'output':
      return { type: 'output', message: message ?? '' };
    case 'done':
      return { type: 'done', message: message ?? '', done: true };
    case 'error': {
      const error = readStringField(record, 'error');
      return { type: 'error', error: error ?? message ?? 'Unknown error', done: true };
    }
    default:
      return null;
  }
}
