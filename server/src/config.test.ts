import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getApiToken,
  getCorsOrigins,
  getDeepSeekApiKey,
  getDeepSeekBaseUrl,
  getDeepSeekModel,
  getHost,
  getOpenAiApiKey,
  getOpenAiBaseUrl,
  getSummaryProviderOverride,
  getVideosFolderPaths,
  invalidateVideosFolderCache,
} from './config';

/**
 * Put an environment variable back the way this file found it.
 *
 * process.env outlives a test FILE inside a jest worker, so a suite that
 * borrows a value has to restore it, not just delete it: the deletion would
 * follow every later file in the same worker. The deep server integration is
 * one of those neighbours — it boots a server whose /api refuses to answer
 * without a VIDEOS_FOLDER_PATH.
 */
function restoreEnv(name: string, original: string | undefined): void {
  if (original === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = original;
  }
}

describe('getVideosFolderPaths', () => {
  const originalVideosFolderPath = process.env.VIDEOS_FOLDER_PATH;
  const originalHome = process.env.HOME;

  afterEach(() => {
    restoreEnv('VIDEOS_FOLDER_PATH', originalVideosFolderPath);
    restoreEnv('HOME', originalHome);
    invalidateVideosFolderCache();
  });

  it('reads a single path', () => {
    process.env.VIDEOS_FOLDER_PATH = '/videos/one';
    expect(getVideosFolderPaths()).toEqual(['/videos/one']);
  });

  it('splits on semicolons and commas and trims the entries', () => {
    process.env.VIDEOS_FOLDER_PATH = ' /videos/a ; /videos/b,/videos/c ';
    expect(getVideosFolderPaths()).toEqual(['/videos/a', '/videos/b', '/videos/c']);
  });

  it('expands a leading ~/ against the home directory', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'video-home-'));
    const homedir = jest.spyOn(os, 'homedir').mockReturnValue(home);
    process.env.VIDEOS_FOLDER_PATH = '~/videos';

    expect(getVideosFolderPaths()).toEqual([path.join(home, 'videos')]);

    homedir.mockRestore();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('throws without a usable value', () => {
    delete process.env.VIDEOS_FOLDER_PATH;
    expect(() => getVideosFolderPaths()).toThrow('VIDEOS_FOLDER_PATH must contain at least one valid folder path');

    process.env.VIDEOS_FOLDER_PATH = ' ; ';
    expect(() => getVideosFolderPaths()).toThrow('VIDEOS_FOLDER_PATH must contain at least one valid folder path');
  });

  describe('glob patterns', () => {
    let base: string;
    let channelA: string;
    let channelB: string;

    beforeEach(() => {
      base = fs.mkdtempSync(path.join(os.tmpdir(), 'video-glob-'));
      channelA = path.join(base, 'drone-a');
      channelB = path.join(base, 'drone-b');
      // channel folders: one recognized by *.info.json, one by config.json
      fs.mkdirSync(channelA);
      fs.writeFileSync(path.join(channelA, '20240101_title.info.json'), '{}');
      fs.mkdirSync(channelB);
      fs.writeFileSync(path.join(channelB, 'config.json'), '{}');
      // distractors: no yt-dlp files, nested info.json, plain file
      fs.mkdirSync(path.join(base, 'drone-c'));
      fs.writeFileSync(path.join(base, 'drone-c', 'notes.txt'), 'x');
      fs.mkdirSync(path.join(base, 'drone-d', 'nested'), { recursive: true });
      fs.writeFileSync(path.join(base, 'drone-d', 'nested', 'x.info.json'), '{}');
      fs.writeFileSync(path.join(base, 'loose.txt'), 'x');
    });

    afterEach(() => {
      fs.rmSync(base, { recursive: true, force: true });
    });

    it('expands * per segment to existing channel folders, sorted', () => {
      process.env.VIDEOS_FOLDER_PATH = `${base}/*`;

      expect(getVideosFolderPaths()).toEqual([channelA, channelB]);
    });

    it('matches a wildcard inside a segment', () => {
      process.env.VIDEOS_FOLDER_PATH = `${base}/drone-*`;

      expect(getVideosFolderPaths()).toEqual([channelA, channelB]);
    });

    it('mixes literal entries with globs and drops duplicates', () => {
      process.env.VIDEOS_FOLDER_PATH = `${channelA};${base}/*`;

      expect(getVideosFolderPaths()).toEqual([channelA, channelB]);
    });

    it('returns an empty list with a warning when nothing matches', () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {
        /* silence the expected folder-miss warning */
      });
      fs.rmSync(channelA, { recursive: true });
      fs.rmSync(channelB, { recursive: true });

      process.env.VIDEOS_FOLDER_PATH = `${base}/*`;
      expect(getVideosFolderPaths()).toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('no folder matched right now'));
      warn.mockRestore();
    });
  });
});

describe('getOpenAiApiKey', () => {
  const originalKey = process.env.OPENAI_API_KEY;

  afterEach(() => {
    restoreEnv('OPENAI_API_KEY', originalKey);
  });

  it('reads the key lazily from the environment', () => {
    delete process.env.OPENAI_API_KEY;
    expect(getOpenAiApiKey()).toBeUndefined();

    process.env.OPENAI_API_KEY = 'sk-test';
    expect(getOpenAiApiKey()).toBe('sk-test');
  });
});

describe('summary provider settings', () => {
  const originals = new Map(
    ['SUMMARY_PROVIDER', 'DEEPSEEK_API_KEY', 'DEEPSEEK_MODEL', 'DEEPSEEK_BASE_URL', 'OPENAI_BASE_URL'].map((name) => [
      name,
      process.env[name],
    ]),
  );

  beforeEach(() => {
    for (const name of originals.keys()) {
      delete process.env[name];
    }
  });

  afterAll(() => {
    for (const [name, value] of originals) {
      restoreEnv(name, value);
    }
  });

  it('getSummaryProviderOverride accepts only the two provider names', () => {
    expect(getSummaryProviderOverride()).toBeUndefined();

    process.env.SUMMARY_PROVIDER = 'openai';
    expect(getSummaryProviderOverride()).toBe('openai');
    process.env.SUMMARY_PROVIDER = 'deepseek';
    expect(getSummaryProviderOverride()).toBe('deepseek');

    // A typo must not silently pick a provider: validateEnv rejects the value
    // at boot and the resolver falls back to the key-based choice.
    process.env.SUMMARY_PROVIDER = 'deepsek';
    expect(getSummaryProviderOverride()).toBeUndefined();
  });

  it('reads the DeepSeek settings lazily, as raw values', () => {
    expect(getDeepSeekApiKey()).toBeUndefined();
    expect(getDeepSeekModel()).toBeUndefined();
    expect(getDeepSeekBaseUrl()).toBeUndefined();

    process.env.DEEPSEEK_API_KEY = 'ds-test';
    // The `:effort` suffix is part of the raw value; llmProviders parses it.
    process.env.DEEPSEEK_MODEL = 'deepseek-v4-pro:max';
    process.env.DEEPSEEK_BASE_URL = 'http://127.0.0.1:9999/v1';

    expect(getDeepSeekApiKey()).toBe('ds-test');
    expect(getDeepSeekModel()).toBe('deepseek-v4-pro:max');
    expect(getDeepSeekBaseUrl()).toBe('http://127.0.0.1:9999/v1');
  });

  it('treats a blank DeepSeek value as unset, so the provider default applies', () => {
    process.env.DEEPSEEK_MODEL = '   ';
    process.env.DEEPSEEK_BASE_URL = '';

    expect(getDeepSeekModel()).toBeUndefined();
    expect(getDeepSeekBaseUrl()).toBeUndefined();
  });

  it('getOpenAiBaseUrl stays undefined so the SDK keeps its own default', () => {
    expect(getOpenAiBaseUrl()).toBeUndefined();
    process.env.OPENAI_BASE_URL = 'http://127.0.0.1:9999/v1';
    expect(getOpenAiBaseUrl()).toBe('http://127.0.0.1:9999/v1');
  });
});

describe('lazy server settings', () => {
  const originalHost = process.env.HOST;
  const originalToken = process.env.API_TOKEN;
  const originalCorsOrigins = process.env.CORS_ORIGINS;

  afterEach(() => {
    restoreEnv('HOST', originalHost);
    restoreEnv('API_TOKEN', originalToken);
    restoreEnv('CORS_ORIGINS', originalCorsOrigins);
  });

  it('getHost defaults to loopback', () => {
    delete process.env.HOST;
    expect(getHost()).toBe('127.0.0.1');
    process.env.HOST = '0.0.0.0';
    expect(getHost()).toBe('0.0.0.0');
  });

  it('getApiToken reads the env lazily, and a blank value counts as unset', () => {
    const original = process.env.API_TOKEN;
    delete process.env.API_TOKEN;
    expect(getApiToken()).toBeUndefined();
    // The compose file renders an unset variable as an empty string, and a
    // token of spaces is nobody's secret: both mean "no token configured".
    process.env.API_TOKEN = '';
    expect(getApiToken()).toBeUndefined();
    process.env.API_TOKEN = '   ';
    expect(getApiToken()).toBeUndefined();
    process.env.API_TOKEN = ' sekret ';
    expect(getApiToken()).toBe('sekret');
    restoreEnv('API_TOKEN', original);
  });

  it('getCorsOrigins splits and trims the list', () => {
    delete process.env.CORS_ORIGINS;
    expect(getCorsOrigins()).toEqual([]);
    process.env.CORS_ORIGINS = ' https://a.example , https://b.example ';
    expect(getCorsOrigins()).toEqual(['https://a.example', 'https://b.example']);
  });
});
