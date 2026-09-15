import { describe, expect, it } from 'vitest';
import { feedSseBuffer, parseSseEvent } from './sse';

describe('feedSseBuffer', () => {
  it('splits complete data: lines off a chunk', () => {
    const frame = feedSseBuffer('', 'data: {"type":"downloadStart"}\n\ndata: {"type":"downloadComplete"}\n\n');
    expect(frame.events).toEqual(['{"type":"downloadStart"}', '{"type":"downloadComplete"}']);
    expect(frame.buffer).toBe('');
  });

  it('keeps an incomplete trailing line in the buffer', () => {
    const frame = feedSseBuffer('', 'data: {"type":"downloadStart"}\n\ndata: {"typ');
    expect(frame.events).toEqual(['{"type":"downloadStart"}']);
    expect(frame.buffer).toBe('data: {"typ');
  });

  it('completes a line split across chunks', () => {
    const first = feedSseBuffer('', 'data: {"type":"downloadSt');
    expect(first.events).toEqual([]);
    const second = feedSseBuffer(first.buffer, 'art"}\n\n');
    expect(second.events).toEqual(['{"type":"downloadStart"}']);
    expect(second.buffer).toBe('');
  });

  it('ignores lines that do not carry data', () => {
    const frame = feedSseBuffer('', ': keep-alive\n\ndata: {"type":"downloadStart"}\n\n');
    expect(frame.events).toEqual(['{"type":"downloadStart"}']);
  });

  it('ignores server heartbeat comment lines between events', () => {
    const frame = feedSseBuffer(
      '',
      'data: {"type":"downloadStart"}\n\n: ping\n\n: ping\n\ndata: {"type":"downloadComplete"}\n\n',
    );
    expect(frame.events).toEqual(['{"type":"downloadStart"}', '{"type":"downloadComplete"}']);
    expect(frame.buffer).toBe('');
  });
});

describe('parseSseEvent', () => {
  it('parses every event type the server sends', () => {
    expect(parseSseEvent('{"type":"downloadStart"}')).toEqual({ type: 'downloadStart' });
    expect(parseSseEvent('{"type":"downloadStart","videoTitle":"Title"}')).toEqual({
      type: 'downloadStart',
      videoTitle: 'Title',
    });
    expect(parseSseEvent('{"type":"downloadProgress","progress":42,"message":"[download] 42%"}')).toEqual({
      type: 'downloadProgress',
      progress: 42,
      message: '[download] 42%',
    });
    expect(parseSseEvent('{"type":"downloadComplete","message":"ok"}')).toEqual({
      type: 'downloadComplete',
      message: 'ok',
    });
    expect(parseSseEvent('{"type":"downloadError","error":"boom"}')).toEqual({
      type: 'downloadError',
      error: 'boom',
    });
  });

  it('drops unknown fields instead of letting them through', () => {
    // The old contract carried `done: true` on terminal events; the schema
    // must not resurrect it.
    expect(parseSseEvent('{"type":"downloadComplete","message":"ok","done":true}')).toEqual({
      type: 'downloadComplete',
      message: 'ok',
    });
  });

  it('returns null for invalid JSON and unknown shapes', () => {
    expect(parseSseEvent('not json')).toBeNull();
    expect(parseSseEvent('"a string"')).toBeNull();
    expect(parseSseEvent('{"type":"mystery"}')).toBeNull();
    expect(parseSseEvent('{}')).toBeNull();
    expect(parseSseEvent('{"type":"downloadStart","videoTitle":42}')).toBeNull();
  });
});
