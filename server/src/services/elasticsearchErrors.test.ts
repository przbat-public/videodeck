import {
  ELASTICSEARCH_UNAVAILABLE_CODE,
  ElasticsearchUnavailableError,
  isElasticsearchUnavailable,
} from './elasticsearchErrors';

const socketError = (message: string, code: string, name = 'Error'): Error =>
  Object.assign(new Error(message), { name, code });

const connectionError = (): Error =>
  socketError('connect ECONNREFUSED 127.0.0.1:9200', 'ECONNREFUSED', 'ConnectionError');

describe('isElasticsearchUnavailable', () => {
  it('recognises the connection error the client throws', () => {
    expect(isElasticsearchUnavailable(connectionError())).toBe(true);
  });

  it('recognises a cause chain that wraps the connection error', () => {
    const outer = Object.assign(new Error('Request failed'), { name: 'ResponseError' });
    outer.cause = connectionError();

    expect(isElasticsearchUnavailable(outer)).toBe(true);
  });

  it('recognises a bare socket code', () => {
    expect(isElasticsearchUnavailable(socketError('connect ETIMEDOUT', 'ETIMEDOUT'))).toBe(true);
    expect(isElasticsearchUnavailable(socketError('getaddrinfo ENOTFOUND elastic', 'ENOTFOUND'))).toBe(true);
  });

  it('recognises the no-living-connections error', () => {
    expect(isElasticsearchUnavailable(socketError('no living connections', '', 'NoLivingConnectionsError'))).toBe(true);
  });

  it('recognises an Elasticsearch 503 response', () => {
    const error = Object.assign(new Error('unavailable'), { name: 'ResponseError', meta: { statusCode: 503 } });

    expect(isElasticsearchUnavailable(error)).toBe(true);
  });

  it('leaves a real bug and a mapping conflict alone', () => {
    expect(isElasticsearchUnavailable(new Error('boom'))).toBe(false);
    expect(isElasticsearchUnavailable(new TypeError('x is not a function'))).toBe(false);
    expect(
      isElasticsearchUnavailable(
        Object.assign(new Error('mapper_parsing_exception'), { name: 'ResponseError', meta: { statusCode: 400 } }),
      ),
    ).toBe(false);
    expect(isElasticsearchUnavailable(undefined)).toBe(false);
    expect(isElasticsearchUnavailable('ECONNREFUSED')).toBe(false);
  });

  it('survives a cyclic cause chain', () => {
    const first = new Error('first');
    const second = new Error('second');
    first.cause = second;
    second.cause = first;

    expect(isElasticsearchUnavailable(first)).toBe(false);
  });
});

describe('ElasticsearchUnavailableError', () => {
  it('carries the code and the status the API answers with', () => {
    const error = new ElasticsearchUnavailableError();

    expect(error.code).toBe(ELASTICSEARCH_UNAVAILABLE_CODE);
    expect(error.statusCode).toBe(503);
    expect(error.message).toBe('Elasticsearch is not reachable');
  });
});
