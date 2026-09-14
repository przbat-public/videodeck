import { describe, expect, it } from 'vitest';
import { feedSseBuffer, parseSseEvent } from './sse';

describe('feedSseBuffer', () => {
  it('splits complete data: lines off a chunk', () => {
    const frame = feedSseBuffer('', 'data: {"type":"start"}\n\ndata: {"type":"done"}\n\n');
    expect(frame.events).toEqual(['{"type":"start"}', '{"type":"done"}']);
    expect(frame.buffer).toBe('');
  });

  it('keeps an incomplete trailing line in the buffer', () => {
    const frame = feedSseBuffer('', 'data: {"type":"start"}\n\ndata: {"typ');
    expect(frame.events).toEqual(['{"type":"start"}']);
    expect(frame.buffer).toBe('data: {"typ');
  });

  it('completes a line split across chunks', () => {
    const first = feedSseBuffer('', 'data: {"type":"st');
    expect(first.events).toEqual([]);
    const second = feedSseBuffer(first.buffer, 'art"}\n\n');
    expect(second.events).toEqual(['{"type":"start"}']);
    expect(second.buffer).toBe('');
  });

  it('ignores lines that do not carry data', () => {
    const frame = feedSseBuffer('', ': keep-alive\n\ndata: {"type":"start"}\n\n');
    expect(frame.events).toEqual(['{"type":"start"}']);
  });
});

describe('parseSseEvent', () => {
  it('parses every event type the server sends', () => {
    expect(parseSseEvent('{"type":"start","message":"go"}')).toEqual({
      type: 'start',
      message: 'go',
    });
    expect(parseSseEvent('{"type":"output","message":"[download] 5%"}')).toEqual({
      type: 'output',
      message: '[download] 5%',
    });
    expect(parseSseEvent('{"type":"done","message":"ok","done":true}')).toEqual({
      type: 'done',
      message: 'ok',
      done: true,
    });
    expect(parseSseEvent('{"type":"error","error":"boom","done":true}')).toEqual({
      type: 'error',
      error: 'boom',
      done: true,
    });
  });

  it('defaults missing messages to empty strings', () => {
    expect(parseSseEvent('{"type":"start"}')).toEqual({ type: 'start', message: '' });
    expect(parseSseEvent('{"type":"error"}')).toEqual({
      type: 'error',
      error: 'Unknown error',
      done: true,
    });
  });

  it('returns null for invalid JSON and unknown shapes', () => {
    expect(parseSseEvent('not json')).toBeNull();
    expect(parseSseEvent('"a string"')).toBeNull();
    expect(parseSseEvent('{"type":"mystery"}')).toBeNull();
    expect(parseSseEvent('{}')).toBeNull();
  });
});
