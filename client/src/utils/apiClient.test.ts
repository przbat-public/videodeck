import {
  CategoriesResponseSchema,
  EnqueueJobsResponseSchema,
  QueuePauseResponseSchema,
} from '@videodeck/shared/schemas';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n';
import { installFetchMock, jsonResponse, type MockResponse } from '../test/fetchMock';
import { ApiRequestError, apiGet, apiSend } from './apiClient';
import { getElasticsearchState, resetElasticsearchState } from './elasticsearchStatus';

const fetchMock = installFetchMock();

describe('apiGet', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    resetElasticsearchState();
  });

  it('returns the parsed answer and keeps a bare request bare', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ categories: ['fpv', 'psychology'] }));

    await expect(apiGet('/api/videos/categories', CategoriesResponseSchema)).resolves.toEqual({
      categories: ['fpv', 'psychology'],
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/videos/categories');
  });

  it('hands the signal and the cache mode straight to fetch', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ categories: [] }));
    const controller = new AbortController();

    await apiGet('/api/folder/queue', CategoriesResponseSchema, {
      signal: controller.signal,
      cache: 'no-store',
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/folder/queue', {
      cache: 'no-store',
      signal: controller.signal,
    });
  });

  it('throws the message the server sent', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'boom', message: 'Channel not allowed' }, 500));

    const failure = await apiGet('/api/videos/categories', CategoriesResponseSchema).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApiRequestError);
    expect(failure).toMatchObject({ message: 'Channel not allowed', status: 500 });
  });

  it('falls back to the generic message when the failure body says nothing', async () => {
    fetchMock.mockResolvedValue(jsonResponse(null, 502));

    await expect(apiGet('/api/videos/categories', CategoriesResponseSchema)).rejects.toThrow(i18n.t('errors.occurred'));
  });

  it('uses the caller wording without reading the failure body', async () => {
    const json = vi.fn(async () => ({ error: 'unread' }));
    fetchMock.mockResolvedValue({ ok: false, status: 503, json });

    await expect(
      apiGet('/api/videos/categories', CategoriesResponseSchema, {
        message: (status) => `HTTP error! status: ${status}`,
      }),
    ).rejects.toThrow('HTTP error! status: 503');
    expect(json).not.toHaveBeenCalled();
  });

  it('hands the parsed failure to failureMessage and flags the dead cluster', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: 'Elasticsearch is not reachable', code: 'elasticsearch_unavailable' }, 503),
    );

    await expect(
      apiGet('/api/videos/categories', CategoriesResponseSchema, {
        failureMessage: (failure, status) => `${status}|${String(failure.elasticsearchDown)}|${failure.message}`,
      }),
    ).rejects.toThrow('503|true|Elasticsearch is not reachable');
    expect(getElasticsearchState()).toBe('down');
  });

  it('propagates a network failure unchanged', async () => {
    const networkError = new TypeError('Failed to fetch');
    fetchMock.mockRejectedValue(networkError);

    await expect(apiGet('/api/videos/categories', CategoriesResponseSchema)).rejects.toBe(networkError);
  });

  it('rejects with the fetch abort error when the signal fires', async () => {
    const controller = new AbortController();
    let seenSignal: AbortSignal | undefined;
    fetchMock.mockImplementationOnce((_url: string, init?: RequestInit) => {
      seenSignal = init?.signal ?? undefined;
      return new Promise<MockResponse>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    });

    const request = apiGet('/api/videos/categories', CategoriesResponseSchema, { signal: controller.signal });
    controller.abort();

    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
    expect(seenSignal).toBe(controller.signal);
  });

  it('surfaces a schema mismatch on an ok answer', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ unexpected: true }));

    await expect(apiGet('/api/videos/categories', CategoriesResponseSchema)).rejects.toThrow();
  });
});

describe('apiSend', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    resetElasticsearchState();
  });

  it('sends the method alone when there is no body', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ paused: true }));

    await expect(apiSend('POST', '/api/folder/queue/pause?paused=1', QueuePauseResponseSchema)).resolves.toEqual({
      paused: true,
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/folder/queue/pause?paused=1', { method: 'POST' });
  });

  it('sends the body as JSON and parses the answer', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ jobs: [], skipped: [] }));

    await expect(
      apiSend('POST', '/api/folder/queue', EnqueueJobsResponseSchema, { folderPath: '/videos' }),
    ).resolves.toEqual({ jobs: [], skipped: [] });
    expect(fetchMock).toHaveBeenCalledWith('/api/folder/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderPath: '/videos' }),
    });
  });

  it('resolves without reading the answer when no schema is given', async () => {
    const json = vi.fn(async () => ({ ignored: true }));
    fetchMock.mockResolvedValue({ ok: true, status: 202, json });

    await expect(apiSend('POST', '/api/videos/refreshCache', null)).resolves.toBeUndefined();
    expect(json).not.toHaveBeenCalled();
  });

  it('throws a status-carrying error for a failed send', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'Index recreation already running' }, 409));

    const failure = await apiSend('POST', '/api/videos/recreateIndices', null).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApiRequestError);
    expect(failure).toMatchObject({ status: 409, message: 'Index recreation already running' });
  });
});
