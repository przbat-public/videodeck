import {
  getApiToken,
  getCorsOrigins,
  getHost,
  getOpenAiApiKey,
  getVideosFolderPaths,
} from './config';

describe('getVideosFolderPaths', () => {
  afterEach(() => {
    delete process.env.VIDEOS_FOLDER_PATH;
  });

  it('reads a single path', () => {
    process.env.VIDEOS_FOLDER_PATH = '/videos/one';
    expect(getVideosFolderPaths()).toEqual(['/videos/one']);
  });

  it('splits on semicolons and commas and trims the entries', () => {
    process.env.VIDEOS_FOLDER_PATH = ' /videos/a ; /videos/b,/videos/c ';
    expect(getVideosFolderPaths()).toEqual(['/videos/a', '/videos/b', '/videos/c']);
  });

  it('throws without a usable value', () => {
    delete process.env.VIDEOS_FOLDER_PATH;
    expect(() => getVideosFolderPaths()).toThrow(
      'VIDEOS_FOLDER_PATH must contain at least one valid folder path'
    );

    process.env.VIDEOS_FOLDER_PATH = ' ; ';
    expect(() => getVideosFolderPaths()).toThrow(
      'VIDEOS_FOLDER_PATH must contain at least one valid folder path'
    );
  });
});

describe('getOpenAiApiKey', () => {
  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
  });

  it('reads the key lazily from the environment', () => {
    delete process.env.OPENAI_API_KEY;
    expect(getOpenAiApiKey()).toBeUndefined();

    process.env.OPENAI_API_KEY = 'sk-test';
    expect(getOpenAiApiKey()).toBe('sk-test');
  });
});

describe('lazy server settings', () => {
  afterEach(() => {
    delete process.env.HOST;
    delete process.env.API_TOKEN;
    delete process.env.CORS_ORIGINS;
  });

  it('getHost defaults to loopback', () => {
    delete process.env.HOST;
    expect(getHost()).toBe('127.0.0.1');
    process.env.HOST = '0.0.0.0';
    expect(getHost()).toBe('0.0.0.0');
  });

  it('getApiToken reads the env lazily', () => {
    delete process.env.API_TOKEN;
    expect(getApiToken()).toBeUndefined();
    process.env.API_TOKEN = 'sekret';
    expect(getApiToken()).toBe('sekret');
  });

  it('getCorsOrigins splits and trims the list', () => {
    delete process.env.CORS_ORIGINS;
    expect(getCorsOrigins()).toEqual([]);
    process.env.CORS_ORIGINS = ' https://a.example , https://b.example ';
    expect(getCorsOrigins()).toEqual(['https://a.example', 'https://b.example']);
  });
});
