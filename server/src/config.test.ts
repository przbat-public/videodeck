import { getVideosFolderPaths, getOpenAiApiKey } from './config';

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
