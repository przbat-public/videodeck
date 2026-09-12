import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  DEFAULT_DOWNLOAD_OPTIONS,
  loadDownloadOptions,
  readFolderConfig,
  resolveDownloadOptions,
  validateFolderConfig,
} from './folderConfig';

describe('folderConfig', () => {
  describe('validateFolderConfig', () => {
    it('accepts an empty object and a full valid config', () => {
      expect(validateFolderConfig({})).toBeNull();
      expect(
        validateFolderConfig({
          channelUrl: 'https://www.youtube.com/@x',
          maxHeight: 1080,
          subLangs: ['en', 'pl', 'en.*', 'all', '-live_chat'],
          writeComments: false,
          somethingElse: 42,
        })
      ).toBeNull();
    });

    it('rejects non-objects', () => {
      expect(validateFolderConfig(null)).toBe('config object is required');
      expect(validateFolderConfig('x')).toBe('config object is required');
      expect(validateFolderConfig([])).toBe('config object is required');
    });

    it('validates channelUrl', () => {
      expect(validateFolderConfig({ channelUrl: 42 })).toBe('channelUrl must be a string');
    });

    it('validates maxHeight', () => {
      expect(validateFolderConfig({ maxHeight: '1080' })).toMatch(/maxHeight/);
      expect(validateFolderConfig({ maxHeight: 1080.5 })).toMatch(/maxHeight/);
      expect(validateFolderConfig({ maxHeight: 100 })).toMatch(/maxHeight/);
      expect(validateFolderConfig({ maxHeight: 9000 })).toMatch(/maxHeight/);
      expect(validateFolderConfig({ maxHeight: 720 })).toBeNull();
    });

    it('validates subLangs', () => {
      expect(validateFolderConfig({ subLangs: 'en' })).toMatch(/subLangs/);
      expect(validateFolderConfig({ subLangs: [''] })).toMatch(/invalid language code/);
      expect(validateFolderConfig({ subLangs: ['en pl'] })).toMatch(/invalid language code/);
      expect(validateFolderConfig({ subLangs: [1] })).toMatch(/invalid language code/);
      expect(validateFolderConfig({ subLangs: [] })).toBeNull();
    });

    it('validates writeComments', () => {
      expect(validateFolderConfig({ writeComments: 'yes' })).toBe(
        'writeComments must be a boolean'
      );
    });
  });

  describe('resolveDownloadOptions', () => {
    it('returns defaults for a missing config', () => {
      expect(resolveDownloadOptions(null)).toEqual(DEFAULT_DOWNLOAD_OPTIONS);
      expect(resolveDownloadOptions(undefined)).toEqual(DEFAULT_DOWNLOAD_OPTIONS);
      expect(resolveDownloadOptions({})).toEqual(DEFAULT_DOWNLOAD_OPTIONS);
    });

    it('does not share the default subLangs array', () => {
      const options = resolveDownloadOptions(null);
      options.subLangs.push('pl');
      expect(DEFAULT_DOWNLOAD_OPTIONS.subLangs).toEqual(['en']);
    });

    it('overrides defaults with config values', () => {
      expect(
        resolveDownloadOptions({
          channelUrl: 'x',
          maxHeight: 1080,
          subLangs: ['pl', 'en'],
          writeComments: false,
        })
      ).toEqual({ maxHeight: 1080, subLangs: ['pl', 'en'], writeComments: false });
    });

    it('allows disabling subtitles with an empty array', () => {
      expect(resolveDownloadOptions({ subLangs: [] }).subLangs).toEqual([]);
    });

    it('ignores invalid values from a hand-edited file', () => {
      expect(
        resolveDownloadOptions({
          maxHeight: 'big' as unknown as number,
          subLangs: ['en', '', 'bad lang', 42 as unknown as string],
          writeComments: 'no' as unknown as boolean,
        })
      ).toEqual({ maxHeight: 2160, subLangs: ['en'], writeComments: true });
    });
  });

  describe('readFolderConfig / loadDownloadOptions', () => {
    let dir: string;

    beforeEach(async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'folder-config-'));
      jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(async () => {
      jest.restoreAllMocks();
      await fs.rm(dir, { recursive: true, force: true });
    });

    it('returns null when config.json is missing', async () => {
      expect(await readFolderConfig(dir)).toBeNull();
      expect(await loadDownloadOptions(dir)).toEqual(DEFAULT_DOWNLOAD_OPTIONS);
      expect(console.error).not.toHaveBeenCalled();
    });

    it('reads and resolves an existing config', async () => {
      await fs.writeFile(
        path.join(dir, 'config.json'),
        JSON.stringify({ channelUrl: 'https://yt/@a', maxHeight: 1080, subLangs: ['pl'] }),
        'utf-8'
      );

      expect(await readFolderConfig(dir)).toEqual({
        channelUrl: 'https://yt/@a',
        maxHeight: 1080,
        subLangs: ['pl'],
      });
      expect(await loadDownloadOptions(dir)).toEqual({
        maxHeight: 1080,
        subLangs: ['pl'],
        writeComments: true,
      });
    });

    it('returns null and logs for a corrupt or non-object file', async () => {
      await fs.writeFile(path.join(dir, 'config.json'), '{oops', 'utf-8');
      expect(await readFolderConfig(dir)).toBeNull();
      expect(console.error).toHaveBeenCalled();

      await fs.writeFile(path.join(dir, 'config.json'), '[1,2]', 'utf-8');
      expect(await readFolderConfig(dir)).toBeNull();
    });
  });
});
