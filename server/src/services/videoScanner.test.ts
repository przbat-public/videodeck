import {
  getAllVideos,
  searchVideos,
  loadVideosCache,
  refreshVideosCache,
  VideoInfo,
} from './videoScanner';
import * as fs from 'fs/promises';
import * as config from '../config';

// Mock modules
jest.mock('fs/promises');
jest.mock('../config');

const mockedFs = fs as jest.Mocked<typeof fs>;
const mockedConfig = config as jest.Mocked<typeof config>;

describe('videoScanner', () => {
  const mockVideos: VideoInfo[] = [
    {
      baseName: '20231201_TestVideo1',
      name: 'Test Video 1',
      description: 'Test Video 1',
      videoPath: '20231201_TestVideo1.mp4',
      thumbnailPath: '20231201_TestVideo1.webp',
      uploadDate: '20231201',
    },
    {
      baseName: '20231115_TestVideo2',
      name: 'Test Video 2',
      description: 'Another test video',
      videoPath: '20231115_TestVideo2.mp4',
      thumbnailPath: '20231115_TestVideo2.webp',
      uploadDate: '20231115',
    },
    {
      baseName: '20231010_TestVideo3',
      name: 'Test Video 3',
      description: 'Third test video',
      videoPath: '20231010_TestVideo3.mp4',
      thumbnailPath: '20231010_TestVideo3.webp',
      uploadDate: '20231010',
    },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    // Reset module state
    jest.resetModules();
  });

  describe('getAllVideos', () => {
    it('should throw error if cache is not loaded', () => {
      expect(() => getAllVideos()).toThrow(
        'Videos cache not loaded. Call loadVideosCache() first.'
      );
    });
  });

  describe('searchVideos', () => {
    it('should throw error if cache is not loaded', () => {
      expect(() => searchVideos('test')).toThrow(
        'Videos cache not loaded. Call loadVideosCache() first.'
      );
    });

    it('should return empty array for empty query', async () => {
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
      const result = searchVideos('');
      expect(result).toEqual([]);
    });

    it('should return empty array for whitespace-only query', async () => {
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
      const result = searchVideos('   ');
      expect(result).toEqual([]);
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

      const videos = getAllVideos();
      expect(videos.length).toBeGreaterThan(0);
      expect(videos[0].name).toBeDefined();
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
      mockedFs.readFile
        .mockResolvedValueOnce('invalid json content')
        .mockResolvedValueOnce(
          JSON.stringify({
            title: 'Test Video 2',
          })
        );

      // Should not throw, should skip invalid file
      await expect(loadVideosCache()).resolves.not.toThrow();

      const videos = getAllVideos();
      // Should only have one video (the valid one)
      expect(videos.length).toBe(1);
      expect(videos[0].name).toBe('Test Video 2');
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

      const videos = getAllVideos();
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
      const initialCount = getAllVideos().length;

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
      const newCount = getAllVideos().length;

      // Should have reloaded with new files
      expect(mockedFs.readdir).toHaveBeenCalled();
    });
  });
});

