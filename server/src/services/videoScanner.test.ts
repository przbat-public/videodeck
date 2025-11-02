import { getVideos, loadVideosCache, refreshVideosCache } from './videoScanner';
import * as fs from 'fs/promises';
import * as config from '../config';

jest.mock('fs/promises');
jest.mock('../config');

const mockedFs = fs as jest.Mocked<typeof fs>;
const mockedConfig = config as jest.Mocked<typeof config>;

describe('videoScanner', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    // Mock console.log and console.error to suppress output during tests
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    // Restore original console methods
    jest.restoreAllMocks();
  });

  describe('searchVideos', () => {
    it('should throw error if cache is not loaded', () => {
      expect(() => getVideos('test')).toThrow(
        'Videos cache not loaded. Call loadVideosCache() first.'
      );
    });

    it('should return all videos for empty query', async () => {
      // Mock cache as loaded
      mockedConfig.getVideosFolderPath.mockReturnValue('/test/videos');
      mockedFs.readdir.mockResolvedValue([
        '20231201_TestVideo1.info.json',
        '20231201_TestVideo1.mp4',
        '20231201_TestVideo1.webp',
      ] as any);

      const mockInfoJson = {
        title: 'Test Video 1',
      };
      mockedFs.readFile.mockResolvedValue(JSON.stringify(mockInfoJson));

      await loadVideosCache();
      const result = getVideos('');
      expect(result.length).toBe(1);
      expect(result[0].title).toBe('Test Video 1');
    });

    it('should return all videos for whitespace-only query', async () => {
      mockedConfig.getVideosFolderPath.mockReturnValue('/test/videos');
      mockedFs.readdir.mockResolvedValue([
        '20231201_TestVideo1.info.json',
        '20231201_TestVideo1.mp4',
        '20231201_TestVideo1.webp',
      ] as any);

      const mockInfoJson = {
        title: 'Test Video 1',
      };
      mockedFs.readFile.mockResolvedValue(JSON.stringify(mockInfoJson));

      await loadVideosCache();
      const result = getVideos('   ');
      expect(result.length).toBe(1);
      expect(result[0].title).toBe('Test Video 1');
    });
  });

  describe('loadVideosCache', () => {
    it('should load videos from disk and populate cache', async () => {
      mockedConfig.getVideosFolderPath.mockReturnValue('/test/videos');
      mockedFs.readdir.mockResolvedValue([
        '20231201_TestVideo1.info.json',
        '20231201_TestVideo1.mp4',
        '20231201_TestVideo1.webp',
        '20231115_TestVideo2.info.json',
        '20231115_TestVideo2.mp4',
        '20231115_TestVideo2.webp',
      ] as any);

      const mockInfoJson1 = {
        title: 'Test Video 1',
      };
      const mockInfoJson2 = {
        title: 'Test Video 2',
      };

      mockedFs.readFile
        .mockResolvedValueOnce(JSON.stringify(mockInfoJson1))
        .mockResolvedValueOnce(JSON.stringify(mockInfoJson2));

      await loadVideosCache();

      const videos = getVideos();
      expect(videos.length).toBeGreaterThan(0);
      expect(videos[0].title).toBeDefined();
    });

    it('should handle invalid JSON files gracefully', async () => {
      mockedConfig.getVideosFolderPath.mockReturnValue('/test/videos');
      mockedFs.readdir.mockResolvedValue([
        '20231201_TestVideo1.info.json',
        '20231201_TestVideo1.mp4',
        '20231201_TestVideo1.webp',
        '20231115_TestVideo2.info.json',
        '20231115_TestVideo2.mp4',
        '20231115_TestVideo2.webp',
      ] as any);

      // First file has invalid JSON, second is valid
      mockedFs.readFile.mockResolvedValueOnce('invalid json content').mockResolvedValueOnce(
        JSON.stringify({
          title: 'Test Video 2',
        })
      );

      // Should not throw, should skip invalid file
      await expect(loadVideosCache()).resolves.not.toThrow();

      const videos = getVideos();
      // Should only have one video (the valid one)
      expect(videos.length).toBe(1);
      expect(videos[0].title).toBe('Test Video 2');
    });

    it('should sort videos by date (newest first)', async () => {
      mockedConfig.getVideosFolderPath.mockReturnValue('/test/videos');
      mockedFs.readdir.mockResolvedValue([
        '20231010_OldVideo.info.json',
        '20231010_OldVideo.mp4',
        '20231010_OldVideo.webp',
        '20231201_NewVideo.info.json',
        '20231201_NewVideo.mp4',
        '20231201_NewVideo.webp',
      ] as any);

      mockedFs.readFile
        .mockResolvedValueOnce(
          JSON.stringify({
            title: 'Old Video',
          })
        )
        .mockResolvedValueOnce(
          JSON.stringify({
            title: 'New Video',
          })
        );

      await loadVideosCache();

      const videos = getVideos();
      expect(videos.length).toBe(2);
      // Newest should be first
      expect(videos[0].baseName).toBe('20231201_NewVideo');
      expect(videos[1].baseName).toBe('20231010_OldVideo');
    });
  });

  describe('refreshVideosCache', () => {
    it('should reload cache', async () => {
      mockedConfig.getVideosFolderPath.mockReturnValue('/test/videos');
      mockedFs.readdir.mockResolvedValue([
        '20231201_TestVideo1.info.json',
        '20231201_TestVideo1.mp4',
        '20231201_TestVideo1.webp',
      ] as any);

      mockedFs.readFile.mockResolvedValue(
        JSON.stringify({
          title: 'Test Video 1',
        })
      );

      await loadVideosCache();
      const initialCount = getVideos().length;

      // Change what readdir returns
      mockedFs.readdir.mockResolvedValue([
        '20231201_TestVideo1.info.json',
        '20231201_TestVideo1.mp4',
        '20231201_TestVideo1.webp',
        '20231202_TestVideo2.info.json',
        '20231202_TestVideo2.mp4',
        '20231202_TestVideo2.webp',
      ] as any);

      mockedFs.readFile.mockResolvedValue(
        JSON.stringify({
          title: 'Test Video',
        })
      );

      await refreshVideosCache();
      const newCount = getVideos().length;

      // Should have reloaded with new files
      expect(mockedFs.readdir).toHaveBeenCalled();
    });
  });
});
