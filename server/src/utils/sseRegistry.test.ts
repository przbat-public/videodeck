import type { Response } from 'express';
import { activeSseStreamCount, closeAllSseStreams, registerSseStream } from './sseRegistry';

describe('sseRegistry', () => {
  const fakeResponse = (): Response => ({ end: jest.fn() }) as unknown as Response;

  it('tracks a stream until it unregisters', () => {
    const unregister = registerSseStream(fakeResponse());
    expect(activeSseStreamCount()).toBe(1);

    unregister();
    unregister();
    expect(activeSseStreamCount()).toBe(0);
  });

  it('ends and forgets every open stream', () => {
    const first = fakeResponse();
    const second = fakeResponse();
    registerSseStream(first);
    registerSseStream(second);

    closeAllSseStreams();

    expect(first.end).toHaveBeenCalled();
    expect(second.end).toHaveBeenCalled();
    expect(activeSseStreamCount()).toBe(0);
  });
});
