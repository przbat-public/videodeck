import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  CATEGORY_CACHE_TTL_MS,
  DEFAULT_DOWNLOAD_OPTIONS,
  getFolderPathsForCategory,
  invalidateCategoryCache,
  listCategories,
  loadDownloadOptions,
  readFolderConfig,
  resolveCategory,
  resolveDownloadOptions,
  validateFolderConfig,
} from './folderConfig';
import { getVideosFolderPaths } from '../config';
import { at } from '../test-utils';

jest.mock('../config');

const mockedGetVideosFolderPaths = getVideosFolderPaths as jest.MockedFunction<
  typeof getVideosFolderPaths
>;

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

    it('validates extraArgs', () => {
      expect(validateFolderConfig({ extraArgs: '--cookies' })).toMatch(/extraArgs/);
      expect(validateFolderConfig({ extraArgs: [''] })).toMatch(/invalid argument/);
      expect(validateFolderConfig({ extraArgs: [42] })).toMatch(/invalid argument/);
      expect(validateFolderConfig({ extraArgs: ['--no-playlist'] })).toBeNull();
    });

    it('rejects dangerous extraArgs', () => {
      expect(validateFolderConfig({ extraArgs: ['--cookies-from-browser', 'chrome'] })).toMatch(
        /restricted argument/
      );
      expect(validateFolderConfig({ extraArgs: ['--exec', 'id'] })).toMatch(/restricted argument/);
      expect(validateFolderConfig({ extraArgs: ['--proxy=http://p'] })).toMatch(
        /restricted argument/
      );
      expect(validateFolderConfig({ extraArgs: ['--config-locations', '/tmp/x'] })).toMatch(
        /restricted argument/
      );
      expect(validateFolderConfig({ extraArgs: ['--cookies', '/tmp/c.txt'] })).toMatch(
        /restricted argument/
      );
      expect(validateFolderConfig({ extraArgs: ['--load-cookies', '/tmp/c.txt'] })).toMatch(
        /restricted argument/
      );
      expect(validateFolderConfig({ extraArgs: ['--netrc'] })).toMatch(/restricted argument/);
      expect(validateFolderConfig({ extraArgs: ['--username', 'u'] })).toMatch(
        /restricted argument/
      );
      expect(validateFolderConfig({ extraArgs: ['--password', 'p'] })).toMatch(
        /restricted argument/
      );
      expect(validateFolderConfig({ extraArgs: ['--video-password', 'p'] })).toMatch(
        /restricted argument/
      );
    });

    it('rejects extraArgs that shadow pipeline-owned flags', () => {
      expect(validateFolderConfig({ extraArgs: ['-f', 'mp4'] })).toMatch(/built-in argument/);
      expect(validateFolderConfig({ extraArgs: ['--format=best'] })).toMatch(/built-in argument/);
      expect(validateFolderConfig({ extraArgs: ['--download-archive', 'other.txt'] })).toMatch(
        /built-in argument/
      );
      expect(validateFolderConfig({ extraArgs: ['--no-download-archive'] })).toMatch(
        /built-in argument/
      );
      expect(validateFolderConfig({ extraArgs: ['-o', 'x.%(ext)s'] })).toMatch(/built-in argument/);
      expect(validateFolderConfig({ extraArgs: ['--merge-output-format', 'mkv'] })).toMatch(
        /built-in argument/
      );
      expect(validateFolderConfig({ extraArgs: ['--format-sort', 'res'] })).toBeNull();
    });

    it('validates category', () => {
      expect(validateFolderConfig({ category: 'fpv' })).toBeNull();
      expect(validateFolderConfig({ category: 'Zdrowie i sport' })).toBeNull();
      expect(validateFolderConfig({ category: 42 })).toBe('category must be a string');
      expect(validateFolderConfig({ category: '  ' })).toMatch(/must not be empty/);
      expect(validateFolderConfig({ category: 'x'.repeat(65) })).toMatch(/at most 64/);
      expect(validateFolderConfig({ category: 'a\nb' })).toMatch(/single line/);
    });

    it('validates the yt-dlp feature toggles', () => {
      expect(
        validateFolderConfig({
          impersonate: true,
          sponsorblockRemove: true,
          concurrentFragments: 4,
        })
      ).toBeNull();
      expect(validateFolderConfig({ impersonate: 'yes' })).toBe('impersonate must be a boolean');
      expect(validateFolderConfig({ sponsorblockRemove: 1 })).toBe(
        'sponsorblockRemove must be a boolean'
      );
      expect(validateFolderConfig({ concurrentFragments: 0 })).toMatch(/between 1 and 16/);
      expect(validateFolderConfig({ concurrentFragments: 32 })).toMatch(/between 1 and 16/);
      expect(validateFolderConfig({ concurrentFragments: 2.5 })).toMatch(/between 1 and 16/);
      expect(validateFolderConfig({ concurrentFragments: '4' })).toMatch(/between 1 and 16/);
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
      ).toEqual({
        maxHeight: 1080,
        subLangs: ['pl', 'en'],
        writeComments: false,
        extraArgs: [],
        impersonate: false,
        concurrentFragments: 1,
        sponsorblockRemove: false,
      });
    });

    it('allows disabling subtitles with an empty array', () => {
      expect(resolveDownloadOptions({ subLangs: [] }).subLangs).toEqual([]);
    });

    it('passes harmless extra yt-dlp arguments through', () => {
      expect(resolveDownloadOptions({ extraArgs: ['--no-playlist', '--no-warnings'] })).toEqual({
        maxHeight: 2160,
        subLangs: ['en'],
        writeComments: true,
        extraArgs: ['--no-playlist', '--no-warnings'],
        impersonate: false,
        concurrentFragments: 1,
        sponsorblockRemove: false,
      });
    });

    it('applies impersonation, SponsorBlock and fragment concurrency from the config', () => {
      expect(
        resolveDownloadOptions({
          impersonate: true,
          sponsorblockRemove: true,
          concurrentFragments: 4,
        })
      ).toEqual({
        maxHeight: 2160,
        subLangs: ['en'],
        writeComments: true,
        extraArgs: [],
        impersonate: true,
        concurrentFragments: 4,
        sponsorblockRemove: true,
      });

      // invalid values from a hand-edited file fall back to the defaults
      expect(
        resolveDownloadOptions({
          impersonate: 'yes' as unknown as boolean,
          concurrentFragments: 99,
        })
      ).toEqual({
        maxHeight: 2160,
        subLangs: ['en'],
        writeComments: true,
        extraArgs: [],
        impersonate: false,
        concurrentFragments: 1,
        sponsorblockRemove: false,
      });
    });

    it('ignores invalid values from a hand-edited file', () => {
      expect(
        resolveDownloadOptions({
          maxHeight: 'big' as unknown as number,
          subLangs: ['en', '', 'bad lang', 42 as unknown as string],
          writeComments: 'no' as unknown as boolean,
          // reserved (-f) and forbidden (--proxy) flags are dropped
          // together with their value
          extraArgs: ['', 42 as unknown as string, '-f', 'best', '--proxy', 'http://p'],
        })
      ).toEqual({
        maxHeight: 2160,
        subLangs: ['en'],
        writeComments: true,
        extraArgs: [],
        impersonate: false,
        concurrentFragments: 1,
        sponsorblockRemove: false,
      });
    });

    it('drops forbidden flags and their values from a hand-edited file', () => {
      expect(
        resolveDownloadOptions({
          extraArgs: ['--exec', 'id', '--proxy=http://p', '--no-playlist'],
        })
      ).toEqual({
        maxHeight: 2160,
        subLangs: ['en'],
        writeComments: true,
        extraArgs: ['--no-playlist'],
        impersonate: false,
        concurrentFragments: 1,
        sponsorblockRemove: false,
      });
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
        extraArgs: [],
        impersonate: false,
        concurrentFragments: 1,
        sponsorblockRemove: false,
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

  describe('categories', () => {
    it('resolveCategory trims and treats a blank or missing value as absent', () => {
      expect(resolveCategory({ category: '  fpv  ' })).toBe('fpv');
      expect(resolveCategory({ category: '   ' })).toBeUndefined();
      expect(resolveCategory({ channelUrl: 'https://yt/@a' })).toBeUndefined();
      expect(resolveCategory(null)).toBeUndefined();
      expect(resolveCategory({ category: 42 as unknown as string })).toBeUndefined();
    });

    describe('across configured folders', () => {
      let folders: string[];

      const writeConfig = (dir: string, config: unknown) =>
        fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(config), 'utf-8');

      beforeEach(async () => {
        invalidateCategoryCache();
        folders = await Promise.all(
          [0, 1, 2, 3].map(() => fs.mkdtemp(path.join(os.tmpdir(), 'folder-category-')))
        );
        mockedGetVideosFolderPaths.mockReturnValue(folders);
        // Folder names deliberately say nothing about the category
        await writeConfig(at(folders, 0), { category: 'fpv' });
        await writeConfig(at(folders, 1), { category: 'psychology' });
        await writeConfig(at(folders, 2), { category: ' FPV ' });
        await writeConfig(at(folders, 3), { channelUrl: 'https://yt/@a' });
      });

      afterEach(async () => {
        jest.restoreAllMocks();
        await Promise.all(folders.map((dir) => fs.rm(dir, { recursive: true, force: true })));
      });

      it('lists distinct categories sorted, collapsing case variants', async () => {
        expect(await listCategories()).toEqual(['fpv', 'psychology']);
      });

      it('matches folders case-insensitively and ignores those without a category', async () => {
        expect(await getFolderPathsForCategory('FpV')).toEqual([at(folders, 0), at(folders, 2)]);
        expect(await getFolderPathsForCategory(' psychology ')).toEqual([at(folders, 1)]);
      });

      it('returns no folders for an unknown or blank category', async () => {
        expect(await getFolderPathsForCategory('lego')).toEqual([]);
        expect(await getFolderPathsForCategory('   ')).toEqual([]);
      });

      it('reads every config once per TTL window, in parallel', async () => {
        const readFile = jest.spyOn(fs, 'readFile');

        await listCategories();
        await getFolderPathsForCategory('fpv');
        await listCategories();

        // one read per folder for the whole burst, not one per call
        expect(readFile).toHaveBeenCalledTimes(folders.length);
      });

      it('picks up an edited config.json after the TTL or on invalidation', async () => {
        expect(await getFolderPathsForCategory('lego')).toEqual([]);
        await writeConfig(at(folders, 3), { category: 'lego' });

        // still cached
        expect(await getFolderPathsForCategory('lego')).toEqual([]);

        invalidateCategoryCache();
        expect(await getFolderPathsForCategory('lego')).toEqual([at(folders, 3)]);

        await writeConfig(at(folders, 3), { category: 'robotics' });
        const later = Date.now() + CATEGORY_CACHE_TTL_MS + 1;
        jest.spyOn(Date, 'now').mockReturnValue(later);
        expect(await getFolderPathsForCategory('robotics')).toEqual([at(folders, 3)]);
      });

      it('does not serve one folder set from the cache built for another', async () => {
        expect(await listCategories()).toEqual(['fpv', 'psychology']);

        mockedGetVideosFolderPaths.mockReturnValue([at(folders, 1)]);
        expect(await listCategories()).toEqual(['psychology']);
      });
    });
  });
});
