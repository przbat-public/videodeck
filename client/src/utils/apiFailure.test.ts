import { beforeEach, describe, expect, it } from 'vitest';
import { readApiFailure } from './apiFailure';
import { getElasticsearchState, resetElasticsearchState } from './elasticsearchStatus';

const response = (body: unknown, status = 503): Response =>
  ({
    ok: status < 400,
    status,
    json: async () => body,
  }) as unknown as Response;

describe('readApiFailure', () => {
  beforeEach(() => {
    resetElasticsearchState();
  });

  it('reads the message the server sent', async () => {
    const failure = await readApiFailure(response({ error: 'folder not allowed', message: 'Folder not allowed' }));

    expect(failure).toEqual({ message: 'Folder not allowed', elasticsearchDown: false });
  });

  it('falls back to the error field', async () => {
    const failure = await readApiFailure(response({ error: 'boom' }, 500));

    expect(failure).toEqual({ message: 'boom', elasticsearchDown: false });
  });

  it('reports an unreachable cluster and turns the banner on', async () => {
    const failure = await readApiFailure(
      response({ error: 'Elasticsearch is not reachable', code: 'elasticsearch_unavailable' }),
    );

    expect(failure).toEqual({ message: 'Elasticsearch is not reachable', elasticsearchDown: true });
    expect(getElasticsearchState()).toBe('down');
  });

  it('survives a body that is not the API error shape', async () => {
    const failure = await readApiFailure(response({ unexpected: true }));

    expect(failure).toEqual({ elasticsearchDown: false });
    expect(getElasticsearchState()).toBe('unknown');
  });

  it('survives a body that is not JSON at all', async () => {
    const failure = await readApiFailure({
      ok: false,
      status: 502,
      json: async () => {
        throw new Error('not json');
      },
    } as unknown as Response);

    expect(failure).toEqual({ elasticsearchDown: false });
  });
});
