import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getApiToken,
  getCorsOrigins,
  getHost,
  getOpenAiApiKey,
  getVideosFolderPaths,
  invalidateVideosFolderCache,
} from './config';

describe('getVideosFolderPaths', () => {
  afterEach(() => {
    delete process.env.VIDEOS_FOLDER_PATH;
    delete process.env.HOME;
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
