import { describe, it, expect } from 'vitest';
import { buildConfig, parseSubLangs, toFormState } from './folderConfigForm';
import type { DownloadOptions } from '@shared/api';

const defaults: DownloadOptions = { maxHeight: 2160, subLangs: ['en'], writeComments: true };

describe('parseSubLangs', () => {
  it('splits on commas and whitespace and drops empties', () => {
    expect(parseSubLangs('en, pl')).toEqual(['en', 'pl']);
    expect(parseSubLangs('  en pl,,de ')).toEqual(['en', 'pl', 'de']);
    expect(parseSubLangs('')).toEqual([]);
  });
});

describe('toFormState', () => {
  it('uses defaults for a missing config', () => {
    expect(toFormState(null, defaults)).toEqual({
      channelUrl: '',
      maxHeight: '',
      subtitlesEnabled: true,
      subLangs: '',
      writeComments: true,
    });
  });

  it('reflects explicit config values', () => {
    expect(
      toFormState(
        {
          channelUrl: 'https://yt/@a',
          maxHeight: 1080,
          subLangs: ['pl', 'en'],
          writeComments: false,
        },
        defaults
      )
    ).toEqual({
      channelUrl: 'https://yt/@a',
      maxHeight: '1080',
      subtitlesEnabled: true,
      subLangs: 'pl, en',
      writeComments: false,
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
        maxHeight: '',
        subtitlesEnabled: true,
        subLangs: '',
        writeComments: true,
      },
      null
    );
    expect(config).toEqual({ writeComments: true });
  });

  it('writes explicit choices with proper types', () => {
    const config = buildConfig(
      {
        channelUrl: ' https://yt/@a ',
        maxHeight: '1080',
        subtitlesEnabled: true,
        subLangs: 'pl, en',
        writeComments: false,
      },
      null
    );
    expect(config).toEqual({
      channelUrl: 'https://yt/@a',
      maxHeight: 1080,
      subLangs: ['pl', 'en'],
      writeComments: false,
    });
  });

  it('disables subtitles with an empty array', () => {
    const config = buildConfig(
      {
        channelUrl: '',
        maxHeight: '',
        subtitlesEnabled: false,
        subLangs: 'pl',
        writeComments: true,
      },
      null
    );
    expect(config.subLangs).toEqual([]);
  });

  it('preserves unknown keys and removes cleared ones', () => {
    const existing = { channelUrl: 'https://yt/@a', maxHeight: 720, custom: 'keep' };
    const config = buildConfig(
      { channelUrl: '', maxHeight: '', subtitlesEnabled: true, subLangs: '', writeComments: true },
      existing
    );
    expect(config).toEqual({ custom: 'keep', writeComments: true });
    expect(existing.maxHeight).toBe(720); // input not mutated
  });
});
