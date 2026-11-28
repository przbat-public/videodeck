import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { invalidateVideosFolderCache } from '../config';
import { getVideoFilePath, normalizeFolderPath, sanitizeFilename, validateVideosFolder } from './videoPathUtils';

describe('normalizeFolderPath', () => {
  const realHomedir = os.homedir();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes plain absolute paths through', () => {
    expect(normalizeFolderPath('/Users/<user>/Downloads/youtube')).toBe('/Users/<user>/Downloads/youtube');
  });

  it('strips trailing slashes (except the root)', () => {
    expect(normalizeFolderPath('/Users/<user>/Downloads/youtube/')).toBe('/Users/<user>/Downloads/youtube');
    expect(normalizeFolderPath('/Users/<user>/Downloads/youtube///')).toBe('/Users/<user>/Downloads/youtube');
    expect(normalizeFolderPath('/')).toBe('/');
  });

  it('expands a leading ~ and ~/', () => {
    const homedir = vi.spyOn(os, 'homedir').mockReturnValue('/home/tester');
    expect(normalizeFolderPath('~/Downloads/youtube')).toBe('/home/tester/Downloads/youtube');
    expect(normalizeFolderPath('~')).toBe('/home/tester');
    expect(normalizeFolderPath('/Users/x')).toBe('/Users/x'); // untouched
    expect(homedir).toHaveBeenCalled();
  });

  it('does not touch other paths', () => {
    expect(normalizeFolderPath('~/')).toBe(realHomedir);
    expect(normalizeFolderPath('relative/x/')).toBe('relative/x');
  });
});

describe('sanitizeFilename', () => {
  it('should return valid filename as-is', () => {
    expect(sanitizeFilename('video.mp4')).toBe('video.mp4');
    expect(sanitizeFilename('test.webp')).toBe('test.webp');
    expect(sanitizeFilename('my-video-file.mp4')).toBe('my-video-file.mp4');
  });

  it('leaves URL encoding alone — Express decodes route params before this runs', () => {
    expect(sanitizeFilename('video%20with%20spaces.mp4')).toBe('video%20with%20spaces.mp4');
    // An encoded separator is a literal percent string, not a path component
    expect(sanitizeFilename('test%2Ffile.mp4')).toBe('test%2Ffile.mp4');
  });

  it('should remove path components using basename', () => {
    expect(sanitizeFilename('/path/to/video.mp4')).toBe('video.mp4');
    expect(sanitizeFilename('../video.mp4')).toBe('video.mp4');
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
  });

  it('should prevent path traversal with "." and ".." as filenames', () => {
    expect(() => sanitizeFilename('.')).toThrow('Invalid filename: path traversal detected');
    expect(() => sanitizeFilename('..')).toThrow('Invalid filename: path traversal detected');
  });

  it('should allow filenames ending with dots', () => {
    expect(sanitizeFilename('file.')).toBe('file.');
    expect(sanitizeFilename('file..webp')).toBe('file..webp');
    expect(sanitizeFilename('name...ext')).toBe('name...ext');
  });

  it('should reject empty filenames', () => {
    expect(() => sanitizeFilename('')).toThrow('Invalid filename: empty filename');
    expect(() => sanitizeFilename('   ')).toThrow('Invalid filename: empty filename');
  });

  it('should handle special characters in filenames', () => {
    expect(sanitizeFilename('file-with-dashes.mp4')).toBe('file-with-dashes.mp4');
    expect(sanitizeFilename('file_with_underscores.mp4')).toBe('file_with_underscores.mp4');
    expect(sanitizeFilename('file123.mp4')).toBe('file123.mp4');
  });

  it('should preserve case sensitivity', () => {
    expect(sanitizeFilename('Video.MP4')).toBe('Video.MP4');
    expect(sanitizeFilename('VIDEO.mp4')).toBe('VIDEO.mp4');
  });

  it('should remove path separators using basename', () => {
    expect(sanitizeFilename('file/name.mp4')).toBe('name.mp4');
    expect(sanitizeFilename('path/to/file.mp4')).toBe('file.mp4');

    const forwardSlashResult = sanitizeFilename('dir/file.mp4');
    expect(forwardSlashResult).toBe('file.mp4');
    expect(forwardSlashResult).not.toContain('/');
  });
});

describe('getVideoFilePath', () => {
  beforeEach(() => {
    process.env.VIDEOS_FOLDER_PATH = '/videos/a;/videos/b';
  });

  it('should return path with sanitized filename', () => {
    const result = getVideoFilePath('test-video.mp4');
    expect(result).toBe('/videos/a/test-video.mp4');
  });

  it('should join a provided folder path', () => {
    expect(getVideoFilePath('x.mp4', '/videos/b')).toBe('/videos/b/x.mp4');
  });

  it('should strip traversal attempts instead of letting them escape', () => {
    expect(getVideoFilePath('../etc/passwd')).toBe('/videos/a/passwd');
    expect(() => getVideoFilePath('')).toThrow('Invalid filename: empty filename');
  });
});

describe('validateVideosFolder', () => {
  // process.env outlives a test file inside a vitest worker, so the value goes
  // back the way this file found it (config.test.ts explains the neighbours).
  const originalVideosFolderPath = process.env.VIDEOS_FOLDER_PATH;
  let base: string;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'video-validate-'));
    fs.mkdirSync(path.join(base, 'MEDIA'));
  });

  afterEach(() => {
    if (originalVideosFolderPath === undefined) {
      delete process.env.VIDEOS_FOLDER_PATH;
    } else {
      process.env.VIDEOS_FOLDER_PATH = originalVideosFolderPath;
    }
    invalidateVideosFolderCache();
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('accepts a literal folder that exists', async () => {
    process.env.VIDEOS_FOLDER_PATH = path.join(base, 'MEDIA');

    await expect(validateVideosFolder()).resolves.toBeUndefined();
  });

  it('refuses a literal folder that does not exist and names the glob that boots without it', async () => {
    // The drive is there with its other channels, and this one is not: a
    // typo, most likely
    const media = path.join(base, 'MEDIA');
    fs.mkdirSync(path.join(media, 'channel-a'));
    process.env.VIDEOS_FOLDER_PATH = path.join(media, 'missing');

    const validation = validateVideosFolder();

    await expect(validation).rejects.toThrow(`${path.join(media, 'missing')} does not exist, but ${media} does`);
    await expect(validation).rejects.toThrow('check the spelling');
    await expect(validation).rejects.toThrow(`${media}/*`);
  });

  it('says the drive looks unmounted when the parent is missing too', async () => {
    const drive = path.join(base, 'NOT_MOUNTED');
    process.env.VIDEOS_FOLDER_PATH = path.join(drive, 'channel');

    const validation = validateVideosFolder();

    await expect(validation).rejects.toThrow(
      `${path.join(drive, 'channel')} does not exist, and neither does ${drive}`,
    );
    await expect(validation).rejects.toThrow('the drive looks unmounted');
    await expect(validation).rejects.toThrow(`${drive}/*`);
  });

  it('says the drive looks unmounted, or misspelled, when the parent is an empty folder', async () => {
    // A Linux mount point (an fstab entry, a Docker bind target) stays behind
    // as an empty folder while its drive is away
    const mountPoint = path.join(base, 'EMPTY_MOUNTPOINT');
    fs.mkdirSync(mountPoint);
    process.env.VIDEOS_FOLDER_PATH = path.join(mountPoint, 'channel');

    const validation = validateVideosFolder();

    await expect(validation).rejects.toThrow(
      `${path.join(mountPoint, 'channel')} does not exist, and ${mountPoint} is empty`,
    );
    await expect(validation).rejects.toThrow('the drive looks unmounted, or check the spelling');
  });

  it('says the drive looks unmounted when the folder is a link left pointing nowhere', async () => {
    // A library root linked into the drive outlives the drive itself
    const target = path.join(base, 'NOT_MOUNTED', 'YouTube');
    const link = path.join(base, 'linked-library');
    fs.symlinkSync(target, link);
    process.env.VIDEOS_FOLDER_PATH = link;

    const validation = validateVideosFolder();

    await expect(validation).rejects.toThrow(`${link} links to ${target}, which does not exist`);
    await expect(validation).rejects.toThrow('the drive looks unmounted');
    // A glob segment matches real directories only, never a link, so the
    // example is built from where the link leads
    await expect(validation).rejects.toThrow(`for example ${path.join(base, 'NOT_MOUNTED')}/*`);
    await expect(validation).rejects.not.toThrow(`for example ${base}/*`);
    await expect(validation).rejects.toThrow('a linked folder then shows up under the path its link leads to');
  });

  it('reads a link written with a trailing slash the same way', async () => {
    const target = path.join(base, 'NOT_MOUNTED', 'YouTube');
    const link = path.join(base, 'linked-library');
    fs.symlinkSync(target, link);
    process.env.VIDEOS_FOLDER_PATH = `${link}/`;

    await expect(validateVideosFolder()).rejects.toThrow(`links to ${target}, which does not exist`);
  });

  it('asks to check the link when it leads into a drive that is there', async () => {
    // The drive holds other folders, so the link's own target was renamed or
    // mistyped rather than unmounted
    const media = path.join(base, 'MEDIA');
    fs.mkdirSync(path.join(media, 'YouTube-renamed'), { recursive: true });
    const link = path.join(base, 'linked-library');
    fs.symlinkSync(path.join(media, 'YouTube'), link);
    process.env.VIDEOS_FOLDER_PATH = link;

    const validation = validateVideosFolder();

    await expect(validation).rejects.toThrow(`${link} links to ${path.join(media, 'YouTube')}, which does not exist`);
    await expect(validation).rejects.toThrow("check the link's target");
    await expect(validation).rejects.not.toThrow('the drive looks unmounted');
  });

  it('promises the glob a warning only when nothing else matches', async () => {
    // Beside a folder that exists, a glob that matches nothing starts the
    // server without a word, so the closing line cannot promise one
    const channel = path.join(base, 'MEDIA', 'channel-a');
    fs.mkdirSync(channel);
    const drive = path.join(base, 'NOT_MOUNTED');
    process.env.VIDEOS_FOLDER_PATH = `${path.join(drive, 'channel')};${channel}`;

    const validation = validateVideosFolder();

    await expect(validation).rejects.toThrow('lets the server start, with a warning only when nothing else matches');
    await expect(validation).rejects.toThrow(`${drive}/*, which also matches the folders beside the missing one`);
  });

  it('boots when a glob matches nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {
      /* silence the expected folder-miss warnings */
    });
    process.env.VIDEOS_FOLDER_PATH = `${path.join(base, 'NOT_MOUNTED')}/*`;

    await expect(validateVideosFolder()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('No video folders found'));
    warn.mockRestore();
  });
});
