import { describe, it, expect } from 'vitest';
import {
  buildConfig,
  collectCategories,
  parseExtraArgs,
  parseSubLangs,
  toFormState,
} from './folderConfigForm';
import type { DownloadOptions } from '@shared/api';

const defaults: DownloadOptions = { maxHeight: 2160, subLangs: ['en'], writeComments: true };

describe('parseSubLangs', () => {
  it('splits on commas and whitespace and drops empties', () => {
    expect(parseSubLangs('en, pl')).toEqual(['en', 'pl']);
    expect(parseSubLangs('  en pl,,de ')).toEqual(['en', 'pl', 'de']);
    expect(parseSubLangs('')).toEqual([]);
  });
});

describe('parseExtraArgs', () => {
  it('splits on whitespace and drops empties', () => {
    expect(parseExtraArgs('--cookies-from-browser chrome')).toEqual([
      '--cookies-from-browser',
      'chrome',
    ]);
    expect(parseExtraArgs('  --proxy http://127.0.0.1:8080  ')).toEqual([
      '--proxy',
      'http://127.0.0.1:8080',
    ]);
    expect(parseExtraArgs('')).toEqual([]);
  });
});

describe('toFormState', () => {
  it('uses defaults for a missing config', () => {
    expect(toFormState(null, defaults)).toEqual({
      channelUrl: '',
      category: '',
      maxHeight: '',
      subtitlesEnabled: true,
      subLangs: '',
      writeComments: true,
      extraArgs: '',
    });
  });

  it('reflects explicit config values', () => {
    expect(
      toFormState(
        {
          channelUrl: 'https://yt/@a',
          category: 'fpv',
          maxHeight: 1080,
          subLangs: ['pl', 'en'],
          writeComments: false,
          extraArgs: ['--proxy', 'http://p'],
        },
        defaults
      )
    ).toEqual({
      channelUrl: 'https://yt/@a',
      category: 'fpv',
      maxHeight: '1080',
      subtitlesEnabled: true,
      subLangs: 'pl, en',
      writeComments: false,
      extraArgs: '--proxy http://p',
    });
  });

  it('shows subtitles as disabled for an empty subLangs array', () => {
    expect(toFormState({ subLangs: [] }, defaults).subtitlesEnabled).toBe(false);
  });
});

describe('buildConfig', () => {
  it('omits keys left at their defaults', () => {
    const config = buildConfig(
      {
        channelUrl: '  ',
        category: '   ',
        maxHeight: '',
        subtitlesEnabled: true,
        subLangs: '',
        writeComments: true,
        extraArgs: '   ',
      },
      null
    );
    expect(config).toEqual({ writeComments: true });
  });

  it('writes explicit choices with proper types', () => {
    const config = buildConfig(
      {
        channelUrl: ' https://yt/@a ',
        category: '  fpv  ',
        maxHeight: '1080',
        subtitlesEnabled: true,
        subLangs: 'pl, en',
        writeComments: false,
        extraArgs: '',
      },
      null
    );
    expect(config).toEqual({
      channelUrl: 'https://yt/@a',
      category: 'fpv',
      maxHeight: 1080,
      subLangs: ['pl', 'en'],
      writeComments: false,
    });
  });

  it('writes extraArgs as an array and clears them when blank', () => {
    const withArgs = buildConfig(
      {
        channelUrl: 'https://yt/@a',
        category: '',
        maxHeight: '',
        subtitlesEnabled: true,
        subLangs: '',
        writeComments: true,
        extraArgs: '--cookies-from-browser chrome',
      },
      null
    );
    expect(withArgs.extraArgs).toEqual(['--cookies-from-browser', 'chrome']);

    const cleared = buildConfig(
      {
        channelUrl: 'https://yt/@a',
        category: '',
        maxHeight: '',
        subtitlesEnabled: true,
        subLangs: '',
        writeComments: true,
        extraArgs: ' ',
      },
      { extraArgs: ['--proxy', 'http://p'] }
    );
    expect(cleared).not.toHaveProperty('extraArgs');
  });

  it('disables subtitles with an empty array', () => {
    const config = buildConfig(
      {
        channelUrl: '',
        category: '',
        maxHeight: '',
        subtitlesEnabled: false,
        subLangs: 'pl',
        writeComments: true,
        extraArgs: '',
      },
      null
    );
    expect(config.subLangs).toEqual([]);
  });

  it('preserves unknown keys and removes cleared ones', () => {
    const existing = {
      channelUrl: 'https://yt/@a',
      category: 'fpv',
      maxHeight: 720,
      custom: 'keep',
    };
    const config = buildConfig(
      {
        channelUrl: '',
        category: '',
        maxHeight: '',
        subtitlesEnabled: true,
        subLangs: '',
        writeComments: true,
        extraArgs: '',
      },
      existing
    );
    expect(config).toEqual({ custom: 'keep', writeComments: true });
    expect(existing.maxHeight).toBe(720); // input not mutated
    expect(existing.category).toBe('fpv');
  });
});

describe('collectCategories', () => {
  it('returns sorted distinct categories and ignores folders without one', () => {
    expect(
      collectCategories({
        '/a': { category: 'psychology' },
        '/b': { category: 'fpv' },
        '/c': { channelUrl: 'https://yt/@a' },
        '/d': null,
      })
    ).toEqual(['fpv', 'psychology']);
  });

  it('collapses case variants and trims, keeping the first spelling', () => {
    expect(
      collectCategories({
        '/a': { category: ' FPV ' },
        '/b': { category: 'fpv' },
        '/c': { category: '   ' },
      })
    ).toEqual(['FPV']);
  });
});
