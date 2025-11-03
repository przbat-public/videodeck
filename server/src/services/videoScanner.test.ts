import { getVideos, loadVideosCache, refreshVideosCache } from './videoScanner';
import * as fs from 'fs/promises';
import * as config from '../config';
import * as elasticsearchService from './elasticsearchService';

jest.mock('fs/promises');
jest.mock('../config');
jest.mock('./elasticsearchService');

const mockedFs = fs as jest.Mocked<typeof fs>;
const mockedConfig = config as jest.Mocked<typeof config>;
const mockedElasticsearchService = elasticsearchService as jest.Mocked<typeof elasticsearchService>;

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

  describe('getVideos', () => {
    beforeEach(() => {
      mockedElasticsearchService.checkElasticsearchConnection.mockResolvedValue(true);
      mockedElasticsearchService.createIndex.mockResolvedValue(undefined);
      mockedElasticsearchService.deleteAllVideosFromFolder.mockResolvedValue(undefined);
      mockedElasticsearchService.indexVideo.mockResolvedValue(undefined);
    });

    it('should return videos from Elasticsearch', async () => {
      const mockVideos = [
        {
          baseName: '20231201_TestVideo1',
          title: 'Test Video 1',
          description: 'Description 1',
          videoPath: '20231201_TestVideo1.mp4',
          thumbnailPath: '20231201_TestVideo1.webp',
          folderPath: '/test/videos',
          comments: [],
        },
      ];

      mockedElasticsearchService.searchVideos.mockResolvedValue(mockVideos);

      const result = await getVideos('');
      expect(result.length).toBe(1);
      expect(result[0].title).toBe('Test Video 1');
      expect(result[0].folderPath).toBe('/test/videos');
      expect(mockedElasticsearchService.searchVideos).toHaveBeenCalledWith('', 'date-desc');
    });

    it('should return videos with query', async () => {
      const mockVideos = [
        {
          baseName: '20231201_TestVideo1',
          title: 'Test Video 1',
          description: 'Description 1',
          videoPath: '20231201_TestVideo1.mp4',
          thumbnailPath: '20231201_TestVideo1.webp',
          folderPath: '/test/videos',
          comments: [],
        },
      ];

      mockedElasticsearchService.searchVideos.mockResolvedValue(mockVideos);

      const result = await getVideos('test');
      expect(result.length).toBe(1);
      expect(mockedElasticsearchService.searchVideos).toHaveBeenCalledWith('test', 'date-desc');
    });

    it('should return videos with sort option', async () => {
      const mockVideos: any[] = [];
      mockedElasticsearchService.searchVideos.mockResolvedValue(mockVideos);

      await getVideos('test', 'views-desc');
      expect(mockedElasticsearchService.searchVideos).toHaveBeenCalledWith('test', 'views-desc');
    });
  });

  describe('loadVideosCache', () => {
    beforeEach(() => {
      mockedElasticsearchService.checkElasticsearchConnection.mockResolvedValue(true);
      mockedElasticsearchService.createIndex.mockResolvedValue(undefined);
      mockedElasticsearchService.deleteAllVideosFromFolder.mockResolvedValue(undefined);
      mockedElasticsearchService.indexVideo.mockResolvedValue(undefined);
    });

    it('should load videos from disk and index them', async () => {
      mockedConfig.getVideosFolderPaths.mockReturnValue(['/test/videos']);
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

      expect(mockedElasticsearchService.createIndex).toHaveBeenCalledWith('/test/videos');
      expect(mockedElasticsearchService.deleteAllVideosFromFolder).toHaveBeenCalledWith('/test/videos');
      expect(mockedElasticsearchService.indexVideo).toHaveBeenCalledTimes(2);
    });

    it('should handle invalid JSON files gracefully', async () => {
      mockedConfig.getVideosFolderPaths.mockReturnValue(['/test/videos']);
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

      // Should only index one video (the valid one)
      expect(mockedElasticsearchService.indexVideo).toHaveBeenCalledTimes(1);
    });
  });

  describe('refreshVideosCache', () => {
    beforeEach(() => {
      mockedElasticsearchService.checkElasticsearchConnection.mockResolvedValue(true);
      mockedElasticsearchService.createIndex.mockResolvedValue(undefined);
      mockedElasticsearchService.deleteAllVideosFromFolder.mockResolvedValue(undefined);
      mockedElasticsearchService.indexVideo.mockResolvedValue(undefined);
    });

    it('should reload cache', async () => {
      mockedConfig.getVideosFolderPaths.mockReturnValue(['/test/videos']);
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
      const initialIndexCalls = mockedElasticsearchService.indexVideo.mock.calls.length;

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

      // Should have reloaded with new files
      expect(mockedFs.readdir).toHaveBeenCalled();
      expect(mockedElasticsearchService.indexVideo.mock.calls.length).toBeGreaterThan(initialIndexCalls);
    });
  });
});
