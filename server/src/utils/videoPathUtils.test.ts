import os from 'node:os';
import { getVideoFilePath, normalizeFolderPath, sanitizeFilename } from './videoPathUtils';

describe('normalizeFolderPath', () => {
  const realHomedir = os.homedir();

  afterEach(() => {
    jest.restoreAllMocks();
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
    const homedir = jest.spyOn(os, 'homedir').mockReturnValue('/home/tester');
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
