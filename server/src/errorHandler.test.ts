import request from 'supertest';
import { createApp, elasticsearchUnavailableThrottle } from './app';
import { listChannelNames } from './services/elasticsearchService';

// Only the channel aggregation is replaced; everything else stays real, so the
// handler under test sees the same app the server runs.
jest.mock('./services/elasticsearchService', () => ({
  ...jest.requireActual('./services/elasticsearchService'),
  listChannelNames: jest.fn(),
}));

const mockedListChannelNames = listChannelNames as jest.MockedFunction<typeof listChannelNames>;

const connectionError = (): Error =>
  Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9200'), { name: 'ConnectionError', code: 'ECONNREFUSED' });

process.env.VIDEOS_FOLDER_PATH = '/test/videos';

/**
 * A stopped Elasticsearch used to answer 500 with a multi-level stack per
 * request. It answers 503 with a code now, and one compact line per window.
 */
describe('errorHandler with an unreachable Elasticsearch', () => {
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    elasticsearchUnavailableThrottle.reset();
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {
      /* captured by the assertions */
    });
    error = jest.spyOn(console, 'error').mockImplementation(() => {
      /* captured by the assertions */
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('answers 503 with the machine-readable code', async () => {
    mockedListChannelNames.mockRejectedValue(connectionError());

    const response = await request(createApp()).get('/api/videos/channels');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      error: 'Elasticsearch is not reachable',
      code: 'elasticsearch_unavailable',
    });
  });

  it('logs one compact line per window instead of a stack per request', async () => {
    mockedListChannelNames.mockRejectedValue(connectionError());
    const app = createApp();

    await request(app).get('/api/videos/channels');
    await request(app).get('/api/videos/channels');

    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0] ?? '');
    expect(line).toContain('Elasticsearch unreachable');
    expect(line).toContain('ConnectionError: connect ECONNREFUSED 127.0.0.1:9200');
    // The path is named, the stack is not printed
    expect(line).toContain('/api/videos/channels');
    expect(warn.mock.calls[0]?.[1]).toBeUndefined();
    expect(error).not.toHaveBeenCalled();
  });

  it('logs again after the window passes', async () => {
    mockedListChannelNames.mockRejectedValue(connectionError());
    const app = createApp();
    const now = jest.spyOn(Date, 'now');

    now.mockReturnValue(1_000);
    await request(app).get('/api/videos/channels');
    now.mockReturnValue(2_000);
    await request(app).get('/api/videos/channels');
    now.mockReturnValue(40_000);
    await request(app).get('/api/videos/channels');

    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('keeps the full stack and the 500 for a real bug', async () => {
    mockedListChannelNames.mockRejectedValue(new TypeError('x is not a function'));

    const response = await request(createApp()).get('/api/videos/channels');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'Internal server error' });
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[1]).toBeInstanceOf(TypeError);
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps the stack for an Elasticsearch error that is not a connection failure', async () => {
    mockedListChannelNames.mockRejectedValue(
      Object.assign(new Error('mapper_parsing_exception'), { name: 'ResponseError', meta: { statusCode: 400 } }),
    );

    const response = await request(createApp()).get('/api/videos/channels');

    expect(response.status).toBe(500);
    expect(error).toHaveBeenCalledTimes(1);
  });
});
