import { vi } from 'vitest';
import type { Mock } from 'vitest';

/**
 * Response-like object returned by mocked fetch calls. Tests describe server
 * replies as plain objects, so the mock is typed on what tests pass in rather
 * than on the full Response class.
 */
export interface MockResponse {
  ok: boolean;
  status?: number;
  /** Absent when a test only cares about `ok`/`status` */
  json?: () => Promise<unknown>;
}

/** The hooks always call fetch with a string URL, so implementations can rely on that */
export type FetchMock = Mock<(url: string, init?: RequestInit) => Promise<MockResponse>>;

export const jsonResponse = (body: unknown, status = 200): MockResponse => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

/** Replace globalThis.fetch with a fresh vitest mock and return it typed */
export function installFetchMock(): FetchMock {
  const fetchMock: FetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}
