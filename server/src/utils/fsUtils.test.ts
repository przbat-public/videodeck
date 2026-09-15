import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { removePartialDownloads } from './fsUtils';

describe('removePartialDownloads', () => {
  let dir: string;
  let consoleWarnSpy: jest.SpyInstance;

  const write = (name: string) => fs.writeFile(path.join(dir, name), 'x');

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'partials-'));
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {
      /* silence expected warnings */
    });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('removes yt-dlp temporary files and leaves real files alone', async () => {
    await Promise.all([
      write('video.mp4.part'),
      write('video.f137.mp4.part'),
      write('video.mp4.part-Frag1'),
      write('video.ytdl'),
      write('video.temp'),
      write('video.mp4'),
      write('video.info.json'),
      write('archive.txt'),
    ]);

    await removePartialDownloads(dir);

    expect(await fs.readdir(dir)).toEqual(['archive.txt', 'video.info.json', 'video.mp4']);
  });

  it('does nothing on a missing or unreadable folder', async () => {
    await expect(removePartialDownloads(path.join(dir, 'nope'))).resolves.toBeUndefined();
  });

  it('keeps going when a single unlink fails', async () => {
    await write('other.ytdl');
    const unlink = jest.spyOn(fs, 'unlink').mockRejectedValueOnce(new Error('busy'));
    await write('video.mp4.part');

    await removePartialDownloads(dir);

    // readdir order: other.ytdl first → its unlink was the one that failed
    expect(await fs.readdir(dir)).toEqual(['other.ytdl']);
    expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('other.ytdl'));
    unlink.mockRestore();
  });
});
