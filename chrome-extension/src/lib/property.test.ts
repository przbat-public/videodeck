import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { feedSseBuffer, parseSseEvent } from './sse';
import { extractProgress } from './progress';
import { getYouTubeVideoId } from './youtube';

/**
 * Property-based tests for the extension's parsers: invariants that must hold
 * for every input, not just the examples.
 */

describe('feedSseBuffer (property)', () => {
  it('collects the same events however a stream is split into chunks', () => {
    const event = fc.oneof(
      fc.record({ type: fc.constant('start' as const), message: fc.string() }),
      fc.record({ type: fc.constant('output' as const), message: fc.string() }),
      fc.record({
        type: fc.constant('done' as const),
        message: fc.string(),
        done: fc.constant(true as const),
      }),
      fc.record({
        type: fc.constant('error' as const),
        error: fc.string(),
        done: fc.constant(true as const),
      })
    );

    fc.assert(
      fc.property(
        fc.array(event, { maxLength: 10 }),
        fc.array(fc.integer({ min: 1, max: 20 }), { minLength: 1, maxLength: 20 }),
        (events, cutPoints) => {
          const stream = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');

          // split the stream at the cumulative cut points
          const cuts = new Set<number>();
          let total = 0;
          for (const cut of cutPoints) {
            total += cut;
            cuts.add(Math.min(total, stream.length));
          }
          const chunks: string[] = [];
          let start = 0;
          for (const end of [...cuts, stream.length].sort((a, b) => a - b)) {
            chunks.push(stream.slice(start, end));
            start = end;
          }

          const collected: unknown[] = [];
          let buffer = '';
          for (const chunk of chunks) {
            const frame = feedSseBuffer(buffer, chunk);
            buffer = frame.buffer;
            for (const raw of frame.events) {
              const event = parseSseEvent(raw);
              if (event !== null) {
                collected.push(event);
              }
            }
          }

          expect(collected).toEqual(events);
        }
      )
    );
  });
});

describe('parseSseEvent (property)', () => {
  it('never throws and returns null or a well-formed event', () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const event = parseSseEvent(raw);
        if (event !== null) {
          expect(['start', 'output', 'done', 'error']).toContain(event.type);
          if (event.type === 'error' || event.type === 'done') {
            expect(event.done).toBe(true);
          }
        }
      })
    );
  });
});

describe('extractProgress (property)', () => {
  it('returns undefined or a percentage within 0..100', () => {
    fc.assert(
      fc.property(fc.string(), (line) => {
        const progress = extractProgress(line);
        if (progress !== undefined) {
          expect(progress).toBeGreaterThanOrEqual(0);
          expect(progress).toBeLessThanOrEqual(100);
        }
      })
    );
  });
});

describe('getYouTubeVideoId (property)', () => {
  it('returns null or exactly an 11-character id', () => {
    fc.assert(
      fc.property(fc.string(), (url) => {
        const id = getYouTubeVideoId(url);
        if (id !== null) {
          expect(id).toMatch(/^[a-zA-Z0-9_-]{11}$/);
        }
      })
    );
  });
});
