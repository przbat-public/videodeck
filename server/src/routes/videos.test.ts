import request from 'supertest';
import express from 'express';
import videosRouter from './videos';
import { getVideos, refreshVideosCache } from '../services/videoScanner';
import { getVideoFilePath } from '../utils/videoPathUtils';
import { buildCommentTree } from '../utils/commentTreeUtils';
import * as fs from 'fs/promises';
import path from 'path';
import { VideoListItem, VideoInfoJson } from '../types';
import { getTotalVideoCount, recreateAllIndices } from '../services/elasticsearchService';
import OpenAI from 'openai';

jest.mock('../services/videoScanner');
jest.mock('../utils/videoPathUtils');
jest.mock('../utils/commentTreeUtils');
jest.mock('fs/promises');
jest.mock('../services/elasticsearchService');
jest.mock('openai');
jest.mock('../config', () => ({
  OPENAI_API_KEY: 'test-api-key',
}));

const mockedGetVideos = getVideos as jest.MockedFunction<typeof getVideos>;
const mockedGetVideoFilePath = getVideoFilePath as jest.MockedFunction<typeof getVideoFilePath>;
const mockedBuildCommentTree = buildCommentTree as jest.MockedFunction<typeof buildCommentTree>;
const mockedFs = fs as jest.Mocked<typeof fs>;
const mockedRefreshVideosCache = refreshVideosCache as jest.MockedFunction<typeof refreshVideosCache>;
const mockedRecreateAllIndices = recreateAllIndices as jest.MockedFunction<typeof recreateAllIndices>;
const mockedGetTotalVideoCount = getTotalVideoCount as jest.MockedFunction<typeof getTotalVideoCount>;
const MockedOpenAI = OpenAI as jest.MockedClass<typeof OpenAI>;

describe('videos router', () => {
  let app: express.Application;

  beforeEach(() => {
    jest.clearAllMocks();
    // Mock console.error to suppress output during tests
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});

    app = express();
    app.use(express.json());
    app.use('/api/videos', videosRouter);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('GET /api/videos/search', () => {
    it('should return videos for a query', async () => {
      const mockVideos: VideoListItem[] = [
        {
          baseName: '20231201_TestVideo',
          title: 'Test Video',
          description: 'A test video',
          videoPath: '20231201_TestVideo.mp4',
          thumbnailPath: '20231201_TestVideo.webp',
          folderPath: '/test/videos',
          comments: [],
        },
      ];

      mockedGetVideos.mockResolvedValue(mockVideos);
      mockedGetTotalVideoCount.mockResolvedValue(100);

      const response = await request(app).get('/api/videos/search?q=test');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ videos: mockVideos, totalCount: 100 });
      expect(mockedGetVideos).toHaveBeenCalledWith('test', 'date-desc');
      expect(mockedGetTotalVideoCount).toHaveBeenCalled();
    });

    it('should use default sort when sort parameter is not provided', async () => {
      const mockVideos: VideoListItem[] = [];
      mockedGetVideos.mockResolvedValue(mockVideos);
      mockedGetTotalVideoCount.mockResolvedValue(0);

      const response = await request(app).get('/api/videos/search?q=test');

      expect(response.status).toBe(200);
      expect(mockedGetVideos).toHaveBeenCalledWith('test', 'date-desc');
      expect(mockedGetTotalVideoCount).toHaveBeenCalled();
    });

    it('should use provided sort parameter', async () => {
      const mockVideos: VideoListItem[] = [];
      mockedGetVideos.mockResolvedValue(mockVideos);
      mockedGetTotalVideoCount.mockResolvedValue(0);

      const response = await request(app).get('/api/videos/search?q=test&sort=title-asc');

      expect(response.status).toBe(200);
      expect(mockedGetVideos).toHaveBeenCalledWith('test', 'title-asc');
      expect(mockedGetTotalVideoCount).toHaveBeenCalled();
    });

    it('should handle empty query', async () => {
      const mockVideos: VideoListItem[] = [];
      mockedGetVideos.mockResolvedValue(mockVideos);
      mockedGetTotalVideoCount.mockResolvedValue(0);

      const response = await request(app).get('/api/videos/search');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ videos: mockVideos, totalCount: 0 });
      expect(mockedGetVideos).toHaveBeenCalledWith(undefined, 'date-desc');
      expect(mockedGetTotalVideoCount).toHaveBeenCalled();
    });

    it('should handle errors from getVideos', async () => {
      const error = new Error('Failed to load videos');
      mockedGetVideos.mockRejectedValue(error);

      const response = await request(app).get('/api/videos/search?q=test');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        error: 'Failed to search videos',
        message: 'Failed to load videos',
      });
      expect(mockedGetTotalVideoCount).not.toHaveBeenCalled();
    });

    it('should handle errors from getTotalVideoCount', async () => {
      const mockVideos: VideoListItem[] = [];
      mockedGetVideos.mockResolvedValue(mockVideos);
      mockedGetTotalVideoCount.mockRejectedValue(new Error('Failed to get count'));

      const response = await request(app).get('/api/videos/search?q=test');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        error: 'Failed to search videos',
        message: 'Failed to get count',
      });
    });

    it('should handle non-Error exceptions', async () => {
      mockedGetVideos.mockRejectedValue('String error');

      const response = await request(app).get('/api/videos/search?q=test');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        error: 'Failed to search videos',
        message: 'Unknown error',
      });
    });
  });

  describe('GET /api/videos/refreshCache', () => {
    it('should start cache refresh process and return immediately', async () => {
      mockedRefreshVideosCache.mockResolvedValue(undefined);

      const response = await request(app).get('/api/videos/refreshCache');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        message: 'Cache refresh process started',
        status: 'ok',
      });
      expect(mockedRefreshVideosCache).toHaveBeenCalled();
    });

    it('should handle errors in background without affecting response', async () => {
      const error = new Error('Failed to refresh');
      mockedRefreshVideosCache.mockRejectedValue(error);

      const response = await request(app).get('/api/videos/refreshCache');

      // Response should still be 200 because errors are handled in background
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        message: 'Cache refresh process started',
        status: 'ok',
      });
      expect(mockedRefreshVideosCache).toHaveBeenCalled();
      
      // Wait a bit for the catch handler to execute
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(console.error).toHaveBeenCalledWith('Error refreshing cache in background:', error);
    });
  });

  describe('POST /api/videos/recreateIndices', () => {
    it('should start indices recreation process and return immediately', async () => {
      mockedRecreateAllIndices.mockResolvedValue(undefined);

      const response = await request(app).post('/api/videos/recreateIndices');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        message: 'Indices recreation process started',
        status: 'ok',
      });
      expect(mockedRecreateAllIndices).toHaveBeenCalled();
    });

    it('should handle errors in background without affecting response', async () => {
      const error = new Error('Failed to recreate indices');
      mockedRecreateAllIndices.mockRejectedValue(error);

      const response = await request(app).post('/api/videos/recreateIndices');

      // Response should still be 200 because errors are handled in background
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        message: 'Indices recreation process started',
        status: 'ok',
      });
      expect(mockedRecreateAllIndices).toHaveBeenCalled();
      
      // Wait a bit for the catch handler to execute
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(console.error).toHaveBeenCalledWith('Error recreating indices in background:', error);
    });
  });

  describe('GET /api/videos/file/:filename', () => {
    const mockVideo: VideoListItem = {
      baseName: '20231201_TestVideo',
      title: 'Test Video',
      description: 'A test video',
      videoPath: '20231201_TestVideo.mp4',
      thumbnailPath: '20231201_TestVideo.webp',
      folderPath: '/test/videos',
      comments: [],
    };

    let sendFileSpy: jest.SpyInstance;

    beforeEach(() => {
      // Mock res.sendFile to prevent actual file sending
      // We need to do this after app creation but before request
      sendFileSpy = jest.spyOn(express.response, 'sendFile').mockImplementation(function (
        this: express.Response,
        filePath: string | path.PlatformPath,
        callback?: (err?: any) => void
      ) {
        // Set content-type header that would normally be set
        const ext = path.extname(filePath.toString()).toLowerCase();
        if (ext === '.mp4') {
          this.setHeader('Content-Type', 'video/mp4');
        } else if (ext === '.webp') {
          this.setHeader('Content-Type', 'image/webp');
        } else {
          this.setHeader('Content-Type', 'application/octet-stream');
        }
        // End the response to prevent hanging
        this.status(200).end();
        // Call the callback to indicate success
        if (callback) {
          callback();
        }
        return this;
      } as any);
    });

    afterEach(() => {
      sendFileSpy.mockRestore();
    });

    it('should serve video file (.mp4)', async () => {
      const filename = '20231201_TestVideo.mp4';
      const mockFilePath = '/test/videos/20231201_TestVideo.mp4';

      mockedGetVideos.mockResolvedValue([mockVideo]);
      mockedGetVideoFilePath.mockReturnValue(mockFilePath);
      mockedFs.access.mockResolvedValue(undefined);

      const response = await request(app).get(`/api/videos/file/${filename}`);

      expect(response.status).toBe(200);
      expect(mockedGetVideos).toHaveBeenCalled();
      expect(mockedGetVideoFilePath).toHaveBeenCalledWith(filename, '/test/videos');
      expect(mockedFs.access).toHaveBeenCalledWith(mockFilePath);
    });

    it('should serve thumbnail file (.webp)', async () => {
      const filename = '20231201_TestVideo.webp';
      const mockFilePath = '/test/videos/20231201_TestVideo.webp';

      mockedGetVideos.mockResolvedValue([mockVideo]);
      mockedGetVideoFilePath.mockReturnValue(mockFilePath);
      mockedFs.access.mockResolvedValue(undefined);

      const response = await request(app).get(`/api/videos/file/${filename}`);

      expect(response.status).toBe(200);
      expect(mockedGetVideoFilePath).toHaveBeenCalledWith(filename, '/test/videos');
    });

    it('should find video by videoPath', async () => {
      const filename = '20231201_TestVideo.mp4';
      const mockFilePath = '/test/videos/20231201_TestVideo.mp4';

      const videoWithMatchingPath: VideoListItem = {
        ...mockVideo,
        videoPath: filename,
      };

      mockedGetVideos.mockResolvedValue([videoWithMatchingPath]);
      mockedGetVideoFilePath.mockReturnValue(mockFilePath);
      mockedFs.access.mockResolvedValue(undefined);

      await request(app).get(`/api/videos/file/${filename}`);

      expect(mockedGetVideoFilePath).toHaveBeenCalledWith(filename, '/test/videos');
    });

    it('should find video by thumbnailPath', async () => {
      const filename = '20231201_TestVideo.webp';
      const mockFilePath = '/test/videos/20231201_TestVideo.webp';

      const videoWithMatchingThumbnail: VideoListItem = {
        ...mockVideo,
        thumbnailPath: filename,
      };

      mockedGetVideos.mockResolvedValue([videoWithMatchingThumbnail]);
      mockedGetVideoFilePath.mockReturnValue(mockFilePath);
      mockedFs.access.mockResolvedValue(undefined);

      await request(app).get(`/api/videos/file/${filename}`);

      expect(mockedGetVideoFilePath).toHaveBeenCalledWith(filename, '/test/videos');
    });

    it('should return 404 when file does not exist', async () => {
      const filename = 'nonexistent.mp4';
      const mockFilePath = '/test/videos/nonexistent.mp4';

      mockedGetVideos.mockResolvedValue([]);
      mockedGetVideoFilePath.mockReturnValue(mockFilePath);
      mockedFs.access.mockRejectedValue(new Error('File not found'));

      const response = await request(app).get(`/api/videos/file/${filename}`);

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'File not found' });
    });

    it('should handle file access errors', async () => {
      const filename = 'test.mp4';
      const mockFilePath = '/test/videos/test.mp4';

      mockedGetVideos.mockResolvedValue([mockVideo]);
      mockedGetVideoFilePath.mockReturnValue(mockFilePath);
      mockedFs.access.mockRejectedValue(new Error('Permission denied'));

      const response = await request(app).get(`/api/videos/file/${filename}`);

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'File not found' });
    });

    it('should set correct Content-Type for .mp4 files', async () => {
      const filename = 'test.mp4';
      const mockFilePath = '/test/videos/test.mp4';

      mockedGetVideos.mockResolvedValue([mockVideo]);
      mockedGetVideoFilePath.mockReturnValue(mockFilePath);
      mockedFs.access.mockResolvedValue(undefined);

      const response = await request(app).get(`/api/videos/file/${filename}`);

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toBe('video/mp4');
    });

    it('should set correct Content-Type for .webp files', async () => {
      const filename = 'test.webp';
      const mockFilePath = '/test/videos/test.webp';

      mockedGetVideos.mockResolvedValue([mockVideo]);
      mockedGetVideoFilePath.mockReturnValue(mockFilePath);
      mockedFs.access.mockResolvedValue(undefined);

      const response = await request(app).get(`/api/videos/file/${filename}`);

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toBe('image/webp');
    });

    it('should use default Content-Type for unknown extensions', async () => {
      const filename = 'test.unknown';
      const mockFilePath = '/test/videos/test.unknown';

      mockedGetVideos.mockResolvedValue([mockVideo]);
      mockedGetVideoFilePath.mockReturnValue(mockFilePath);
      mockedFs.access.mockResolvedValue(undefined);

      const response = await request(app).get(`/api/videos/file/${filename}`);

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toBe('application/octet-stream');
    });

    it('should handle errors during file serving', async () => {
      const filename = 'test.mp4';
      const error = new Error('Failed to read file');

      mockedGetVideos.mockResolvedValue([mockVideo]);
      mockedGetVideoFilePath.mockImplementation(() => {
        throw error;
      });

      const response = await request(app).get(`/api/videos/file/${filename}`);

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        error: 'Failed to serve file',
        message: 'Failed to read file',
      });
    });

    it('should log filename in development mode', async () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';

      const filename = 'test.mp4';
      const mockFilePath = '/test/videos/test.mp4';

      mockedGetVideos.mockResolvedValue([mockVideo]);
      mockedGetVideoFilePath.mockReturnValue(mockFilePath);
      mockedFs.access.mockResolvedValue(undefined);

      await request(app).get(`/api/videos/file/${filename}`);

      expect(console.log).toHaveBeenCalledWith('Received filename:', filename);

      process.env.NODE_ENV = originalEnv;
    });
  });

  describe('GET /api/videos/:baseName/summary', () => {
    const mockVideo: VideoListItem = {
      baseName: '20231201_TestVideo',
      title: 'Test Video',
      description: 'A test video',
      videoPath: '20231201_TestVideo.mp4',
      thumbnailPath: '20231201_TestVideo.webp',
      folderPath: '/test/videos',
      comments: [],
      subtitlePath: '20231201_TestVideo.vtt',
    };

    const mockVttContent = `WEBVTT

00:00:01.000 --> 00:00:04.000
This is a test subtitle

00:00:05.000 --> 00:00:08.000
And another one`;

    const mockOpenAIInstance = {
      chat: {
        completions: {
          create: jest.fn(),
        },
      },
    };

    beforeEach(() => {
      jest.clearAllMocks();
      MockedOpenAI.mockImplementation(() => mockOpenAIInstance as any);
    });

    it('should return existing summary from file if it exists', async () => {
      const baseName = '20231201_TestVideo';
      const summaryFilePath = path.join(mockVideo.folderPath, `${baseName}.summary.txt`);
      const existingSummary = 'Existing summary from file';

      mockedGetVideos.mockResolvedValue([mockVideo]);
      // First call: summary file exists
      mockedFs.readFile.mockResolvedValueOnce(existingSummary);

      const response = await request(app).get(`/api/videos/${baseName}/summary`);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ summary: existingSummary });
      expect(mockedGetVideos).toHaveBeenCalledWith(baseName);
      expect(mockedFs.readFile).toHaveBeenCalledWith(summaryFilePath, 'utf-8');
      // Should not call OpenAI API when summary file exists
      expect(mockOpenAIInstance.chat.completions.create).not.toHaveBeenCalled();
    });

    it('should generate and save new summary when file does not exist', async () => {
      const baseName = '20231201_TestVideo';
      const subtitleFilePath = path.join(mockVideo.folderPath, mockVideo.subtitlePath!);
      const summaryFilePath = path.join(mockVideo.folderPath, `${baseName}.summary.txt`);
      const mockSummary = 'This is a test video summary';

      mockedGetVideos.mockResolvedValue([mockVideo]);
      // First call: summary file doesn't exist (throw error)
      mockedFs.readFile.mockRejectedValueOnce(new Error('File not found'));
      // Second call: read subtitle file
      mockedFs.readFile.mockResolvedValueOnce(mockVttContent);
      mockedFs.writeFile.mockResolvedValue(undefined);
      mockOpenAIInstance.chat.completions.create.mockResolvedValue({
        choices: [
          {
            message: {
              content: mockSummary,
            },
          },
        ],
      } as any);

      const response = await request(app).get(`/api/videos/${baseName}/summary`);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ summary: mockSummary });
      expect(mockedGetVideos).toHaveBeenCalledWith(baseName);
      expect(mockedFs.readFile).toHaveBeenCalledWith(summaryFilePath, 'utf-8');
      expect(mockedFs.readFile).toHaveBeenCalledWith(subtitleFilePath, 'utf-8');
      expect(mockOpenAIInstance.chat.completions.create).toHaveBeenCalled();
      expect(mockedFs.writeFile).toHaveBeenCalledWith(summaryFilePath, mockSummary, 'utf-8');
    });

    it('should return video summary', async () => {
      const baseName = '20231201_TestVideo';
      const subtitleFilePath = path.join(mockVideo.folderPath, mockVideo.subtitlePath!);
      const summaryFilePath = path.join(mockVideo.folderPath, `${baseName}.summary.txt`);
      const mockSummary = 'This is a test video summary';

      mockedGetVideos.mockResolvedValue([mockVideo]);
      // Summary file doesn't exist
      mockedFs.readFile.mockRejectedValueOnce(new Error('File not found'));
      // Read subtitle file
      mockedFs.readFile.mockResolvedValueOnce(mockVttContent);
      mockedFs.writeFile.mockResolvedValue(undefined);
      mockOpenAIInstance.chat.completions.create.mockResolvedValue({
        choices: [
          {
            message: {
              content: mockSummary,
            },
          },
        ],
      } as any);

      const response = await request(app).get(`/api/videos/${baseName}/summary`);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ summary: mockSummary });
      expect(mockedGetVideos).toHaveBeenCalledWith(baseName);
      expect(mockedFs.readFile).toHaveBeenCalledWith(subtitleFilePath, 'utf-8');
      expect(mockOpenAIInstance.chat.completions.create).toHaveBeenCalled();
      expect(mockedFs.writeFile).toHaveBeenCalledWith(summaryFilePath, mockSummary, 'utf-8');
    });

    it('should return empty summary when summary file exists but is empty', async () => {
      const baseName = '20231201_TestVideo';
      const subtitleFilePath = path.join(mockVideo.folderPath, mockVideo.subtitlePath!);
      const summaryFilePath = path.join(mockVideo.folderPath, `${baseName}.summary.txt`);
      const mockSummary = 'Generated summary';

      mockedGetVideos.mockResolvedValue([mockVideo]);
      // Summary file exists but is empty
      mockedFs.readFile.mockResolvedValueOnce('');
      // Read subtitle file
      mockedFs.readFile.mockResolvedValueOnce(mockVttContent);
      mockedFs.writeFile.mockResolvedValue(undefined);
      mockOpenAIInstance.chat.completions.create.mockResolvedValue({
        choices: [
          {
            message: {
              content: mockSummary,
            },
          },
        ],
      } as any);

      const response = await request(app).get(`/api/videos/${baseName}/summary`);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ summary: mockSummary });
      expect(mockedFs.readFile).toHaveBeenCalledWith(subtitleFilePath, 'utf-8');
      expect(mockOpenAIInstance.chat.completions.create).toHaveBeenCalled();
    });

    it('should return 404 when video is not found', async () => {
      const baseName = 'nonexistent';

      mockedGetVideos.mockResolvedValue([]);

      const response = await request(app).get(`/api/videos/${baseName}/summary`);

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'Subtitle not found' });
    });

    it('should return 404 when video has no subtitlePath', async () => {
      const baseName = '20231201_TestVideo';
      const videoWithoutSubtitle: VideoListItem = {
        ...mockVideo,
        subtitlePath: undefined,
      };

      mockedGetVideos.mockResolvedValue([videoWithoutSubtitle]);

      const response = await request(app).get(`/api/videos/${baseName}/summary`);

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'Subtitle not found' });
    });

    it('should include truncated field when text is truncated', async () => {
      const baseName = '20231201_TestVideo';
      const subtitleFilePath = path.join(mockVideo.folderPath, mockVideo.subtitlePath!);
      const summaryFilePath = path.join(mockVideo.folderPath, `${baseName}.summary.txt`);
      const mockSummary = 'Generated summary';
      // Create a very long subtitle text that would exceed token limit
      const longVttContent = `WEBVTT\n\n${Array(100000).fill('00:00:01.000 --> 00:00:04.000\nThis is a very long subtitle text that exceeds token limits. ').join('\n')}`;

      mockedGetVideos.mockResolvedValue([mockVideo]);
      mockedFs.readFile.mockRejectedValueOnce(new Error('File not found'));
      mockedFs.readFile.mockResolvedValueOnce(longVttContent);
      mockedFs.writeFile.mockResolvedValue(undefined);
      mockOpenAIInstance.chat.completions.create.mockResolvedValue({
        choices: [
          {
            message: {
              content: mockSummary,
            },
          },
        ],
      } as any);

      const response = await request(app).get(`/api/videos/${baseName}/summary`);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ summary: mockSummary, truncated: true });
      expect(mockOpenAIInstance.chat.completions.create).toHaveBeenCalled();
    });

    it.skip('should return 500 when OpenAI API key is not configured', async () => {
      // Skipping this test as it requires complex module reloading that breaks other mocks
      // The functionality is tested in integration tests
    });

    it('should try next model when rate limit is hit', async () => {
      const baseName = '20231201_TestVideo';
      const subtitleFilePath = path.join(mockVideo.folderPath, mockVideo.subtitlePath!);
      const summaryFilePath = path.join(mockVideo.folderPath, `${baseName}.summary.txt`);
      const mockSummary = 'Generated summary';

      mockedGetVideos.mockResolvedValue([mockVideo]);
      mockedFs.readFile.mockRejectedValueOnce(new Error('File not found'));
      mockedFs.readFile.mockResolvedValueOnce(mockVttContent);
      mockedFs.writeFile.mockResolvedValue(undefined);
      
      // First model fails with rate limit (429 status)
      const rateLimitError = new Error('Rate limit exceeded') as any;
      rateLimitError.status = 429;
      mockOpenAIInstance.chat.completions.create
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValueOnce({
          choices: [
            {
              message: {
                content: mockSummary,
              },
            },
          ],
        } as any);

      const response = await request(app).get(`/api/videos/${baseName}/summary`);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ summary: mockSummary });
      expect(mockOpenAIInstance.chat.completions.create).toHaveBeenCalledTimes(2);
      // Verify first call failed with rate limit
      expect(mockOpenAIInstance.chat.completions.create.mock.calls[0]).toBeDefined();
      // Verify second call succeeded
      expect(mockOpenAIInstance.chat.completions.create.mock.calls[1]).toBeDefined();
    });

    it('should handle write file error gracefully', async () => {
      const baseName = '20231201_TestVideo';
      const subtitleFilePath = path.join(mockVideo.folderPath, mockVideo.subtitlePath!);
      const summaryFilePath = path.join(mockVideo.folderPath, `${baseName}.summary.txt`);
      const mockSummary = 'Generated summary';

      mockedGetVideos.mockResolvedValue([mockVideo]);
      // Summary file doesn't exist
      mockedFs.readFile.mockRejectedValueOnce(new Error('File not found'));
      // Read subtitle file
      mockedFs.readFile.mockResolvedValueOnce(mockVttContent);
      // Write fails but should not affect response
      mockedFs.writeFile.mockRejectedValue(new Error('Write failed'));
      mockOpenAIInstance.chat.completions.create.mockResolvedValue({
        choices: [
          {
            message: {
              content: mockSummary,
            },
          },
        ],
      } as any);

      const response = await request(app).get(`/api/videos/${baseName}/summary`);

      // Should still return summary even if write fails
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ summary: mockSummary });
      expect(mockedFs.writeFile).toHaveBeenCalledWith(summaryFilePath, mockSummary, 'utf-8');
    });

    it('should return 500 when OpenAI API does not return summary', async () => {
      const baseName = '20231201_TestVideo';
      const subtitleFilePath = path.join(mockVideo.folderPath, mockVideo.subtitlePath!);
      const summaryFilePath = path.join(mockVideo.folderPath, `${baseName}.summary.txt`);

      mockedGetVideos.mockResolvedValue([mockVideo]);
      // Summary file doesn't exist
      mockedFs.readFile.mockRejectedValueOnce(new Error('File not found'));
      // Read subtitle file
      mockedFs.readFile.mockResolvedValueOnce(mockVttContent);
      // OpenAI returns empty choices
      mockOpenAIInstance.chat.completions.create.mockResolvedValue({
        choices: [{}],
      } as any);

      const response = await request(app).get(`/api/videos/${baseName}/summary`);

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        error: 'Failed to generate summary',
        message: 'OpenAI API did not return a summary',
      });
    });

    it('should handle errors from subtitle file reading', async () => {
      const baseName = '20231201_TestVideo';
      const subtitleFilePath = path.join(mockVideo.folderPath, mockVideo.subtitlePath!);
      const summaryFilePath = path.join(mockVideo.folderPath, `${baseName}.summary.txt`);
      const error = new Error('Subtitle file not found');

      mockedGetVideos.mockResolvedValue([mockVideo]);
      // Summary file doesn't exist
      mockedFs.readFile.mockRejectedValueOnce(new Error('Summary file not found'));
      // Subtitle file read fails
      mockedFs.readFile.mockRejectedValueOnce(error);

      const response = await request(app).get(`/api/videos/${baseName}/summary`);

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        error: 'Failed to get video summary',
        message: 'Subtitle file not found',
      });
    });

    it('should handle errors from OpenAI API', async () => {
      const baseName = '20231201_TestVideo';
      const subtitleFilePath = path.join(mockVideo.folderPath, mockVideo.subtitlePath!);
      const summaryFilePath = path.join(mockVideo.folderPath, `${baseName}.summary.txt`);
      const error = new Error('OpenAI API error');

      mockedGetVideos.mockResolvedValue([mockVideo]);
      // Summary file doesn't exist
      mockedFs.readFile.mockRejectedValueOnce(new Error('File not found'));
      // Read subtitle file succeeds
      mockedFs.readFile.mockResolvedValueOnce(mockVttContent);
      // OpenAI API call fails
      mockOpenAIInstance.chat.completions.create.mockRejectedValue(error);

      const response = await request(app).get(`/api/videos/${baseName}/summary`);

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        error: 'Failed to get video summary',
        message: 'OpenAI API error',
      });
    });

    it('should extract text from VTT subtitles correctly', async () => {
      const baseName = '20231201_TestVideo';
      const subtitleFilePath = path.join(mockVideo.folderPath, mockVideo.subtitlePath!);
      const summaryFilePath = path.join(mockVideo.folderPath, `${baseName}.summary.txt`);
      const vttWithMetadata = `WEBVTT

1
00:00:01.000 --> 00:00:04.000
This is a test subtitle

2
00:00:05.000 --> 00:00:08.000
And another one`;
      const mockSummary = 'Summary';

      mockedGetVideos.mockResolvedValue([mockVideo]);
      // Summary file doesn't exist
      mockedFs.readFile.mockRejectedValueOnce(new Error('File not found'));
      // Read subtitle file with metadata
      mockedFs.readFile.mockResolvedValueOnce(vttWithMetadata);
      mockedFs.writeFile.mockResolvedValue(undefined);
      mockOpenAIInstance.chat.completions.create.mockResolvedValue({
        choices: [
          {
            message: {
              content: mockSummary,
            },
          },
        ],
      } as any);

      const response = await request(app).get(`/api/videos/${baseName}/summary`);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ summary: mockSummary });
      
      // Verify that OpenAI was called with cleaned text (without timestamps)
      const createCall = mockOpenAIInstance.chat.completions.create.mock.calls[0];
      expect(createCall[0].messages[1].content).toContain('This is a test subtitle');
      expect(createCall[0].messages[1].content).not.toContain('00:00:01.000');
      expect(createCall[0].messages[1].content).not.toContain('WEBVTT');
    });
  });

  describe('GET /api/videos/:baseName/details', () => {
    const mockVideo: VideoListItem = {
      baseName: '20231201_TestVideo',
      title: 'Test Video',
      description: 'A test video',
      videoPath: '20231201_TestVideo.mp4',
      thumbnailPath: '20231201_TestVideo.webp',
      folderPath: '/test/videos',
      comments: [],
      subtitlePath: '20231201_TestVideo.vtt',
    };

    const mockInfoJson: VideoInfoJson = {
      title: 'Test Video Title',
      fulltitle: 'Test Video Full Title',
      description: 'Test Description',
      upload_date: '20231201',
      duration_string: '10:30',
      view_count: 1000,
      like_count: 50,
      channel: 'Test Channel',
      uploader: 'Test Uploader',
      comment_count: 5,
      comments: [],
    };

    it('should return video details', async () => {
      const baseName = '20231201_TestVideo';
      const infoJsonPath = path.join(mockVideo.folderPath, `${baseName}.info.json`);

      mockedGetVideos.mockResolvedValue([mockVideo]);
      mockedFs.access.mockResolvedValue(undefined);
      mockedFs.readFile.mockResolvedValue(JSON.stringify(mockInfoJson));
      mockedBuildCommentTree.mockReturnValue([]);

      const response = await request(app).get(`/api/videos/${baseName}/details`);

      expect(response.status).toBe(200);
      expect(response.body.details).toMatchObject({
        title: 'Test Video Title',
        description: 'Test Description',
        uploadDate: '20231201',
        duration: '10:30',
        viewCount: 1000,
        likeCount: 50,
        channelName: 'Test Channel',
        comments: [],
        commentCount: 5,
        videoPath: mockVideo.videoPath,
        thumbnailPath: mockVideo.thumbnailPath,
        subtitlePath: mockVideo.subtitlePath,
      });
      expect(mockedFs.readFile).toHaveBeenCalledWith(infoJsonPath, 'utf-8');
      expect(mockedBuildCommentTree).toHaveBeenCalledWith([]);
    });

    it('should use fulltitle when title is not available', async () => {
      const baseName = '20231201_TestVideo';
      const infoJsonWithoutTitle: VideoInfoJson = {
        fulltitle: 'Full Title Only',
        description: 'Test Description',
      };

      mockedGetVideos.mockResolvedValue([mockVideo]);
      mockedFs.access.mockResolvedValue(undefined);
      mockedFs.readFile.mockResolvedValue(JSON.stringify(infoJsonWithoutTitle));
      mockedBuildCommentTree.mockReturnValue([]);

      const response = await request(app).get(`/api/videos/${baseName}/details`);

      expect(response.status).toBe(200);
      expect(response.body.details.title).toBe('Full Title Only');
      expect(response.body.details.description).toBe('Test Description');
    });

    it('should use uploader when channel is not available', async () => {
      const baseName = '20231201_TestVideo';
      const infoJsonWithoutChannel: VideoInfoJson = {
        title: 'Test Video',
        uploader: 'Test Uploader',
      };

      mockedGetVideos.mockResolvedValue([mockVideo]);
      mockedFs.access.mockResolvedValue(undefined);
      mockedFs.readFile.mockResolvedValue(JSON.stringify(infoJsonWithoutChannel));
      mockedBuildCommentTree.mockReturnValue([]);

      const response = await request(app).get(`/api/videos/${baseName}/details`);

      expect(response.status).toBe(200);
      expect(response.body.details.channelName).toBe('Test Uploader');
    });

    it('should use duration_string or convert duration to string', async () => {
      const baseName = '20231201_TestVideo';
      const infoJsonWithNumericDuration: VideoInfoJson = {
        title: 'Test Video',
        duration: 630, // 10:30 in seconds
      };

      mockedGetVideos.mockResolvedValue([mockVideo]);
      mockedFs.access.mockResolvedValue(undefined);
      mockedFs.readFile.mockResolvedValue(JSON.stringify(infoJsonWithNumericDuration));
      mockedBuildCommentTree.mockReturnValue([]);

      const response = await request(app).get(`/api/videos/${baseName}/details`);

      expect(response.status).toBe(200);
      expect(response.body.details.duration).toBe('630');
    });

    it('should build comment tree from comments', async () => {
      const baseName = '20231201_TestVideo';
      const mockComments = [
        { id: '1', text: 'Comment 1', parent: 'root' },
        { id: '2', text: 'Comment 2', parent: '1' },
      ];
      const mockTree = [{ id: '1', text: 'Comment 1', replies: [{ id: '2', text: 'Comment 2' }] }];

      const infoJsonWithComments: VideoInfoJson = {
        title: 'Test Video',
        comments: mockComments as any,
      };

      mockedGetVideos.mockResolvedValue([mockVideo]);
      mockedFs.access.mockResolvedValue(undefined);
      mockedFs.readFile.mockResolvedValue(JSON.stringify(infoJsonWithComments));
      mockedBuildCommentTree.mockReturnValue(mockTree as any);

      const response = await request(app).get(`/api/videos/${baseName}/details`);

      expect(response.status).toBe(200);
      expect(mockedBuildCommentTree).toHaveBeenCalledWith(mockComments);
      expect(response.body.details.comments).toEqual(mockTree);
    });

    it('should return 404 when video is not found', async () => {
      const baseName = 'nonexistent';

      mockedGetVideos.mockResolvedValue([]);

      const response = await request(app).get(`/api/videos/${baseName}/details`);

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'Video not found' });
    });

    it('should return 404 when info.json file does not exist', async () => {
      const baseName = '20231201_TestVideo';

      mockedGetVideos.mockResolvedValue([mockVideo]);
      mockedFs.access.mockRejectedValue(new Error('File not found'));

      const response = await request(app).get(`/api/videos/${baseName}/details`);

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'Video details not found' });
    });

    it('should return 500 for invalid JSON in info.json', async () => {
      const baseName = '20231201_TestVideo';
      const infoJsonPath = path.join(mockVideo.folderPath, `${baseName}.info.json`);

      mockedGetVideos.mockResolvedValue([mockVideo]);
      mockedFs.access.mockResolvedValue(undefined);
      mockedFs.readFile.mockResolvedValue('invalid json content');

      const response = await request(app).get(`/api/videos/${baseName}/details`);

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        error: 'Invalid JSON format in video metadata',
        message: 'The video metadata file is corrupted or invalid',
      });
    });

    it('should handle file read errors', async () => {
      const baseName = '20231201_TestVideo';
      const infoJsonPath = path.join(mockVideo.folderPath, `${baseName}.info.json`);
      const error = new Error('Permission denied');

      mockedGetVideos.mockResolvedValue([mockVideo]);
      mockedFs.access.mockResolvedValue(undefined);
      mockedFs.readFile.mockRejectedValue(error);

      const response = await request(app).get(`/api/videos/${baseName}/details`);

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        error: 'Failed to load video details',
        message: 'Permission denied',
      });
    });

    it('should handle errors when getVideos fails', async () => {
      const baseName = '20231201_TestVideo';
      const error = new Error('Failed to load videos');

      mockedGetVideos.mockRejectedValue(error);

      const response = await request(app).get(`/api/videos/${baseName}/details`);

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        error: 'Failed to load video details',
        message: 'Failed to load videos',
      });
    });

    it('should use comments.length as fallback for commentCount', async () => {
      const baseName = '20231201_TestVideo';
      const mockComments = [{ id: '1', text: 'Comment 1' }];
      const mockTree = [{ id: '1', text: 'Comment 1' }];

      const infoJsonWithoutCommentCount: VideoInfoJson = {
        title: 'Test Video',
        comments: mockComments as any,
      };

      mockedGetVideos.mockResolvedValue([mockVideo]);
      mockedFs.access.mockResolvedValue(undefined);
      mockedFs.readFile.mockResolvedValue(JSON.stringify(infoJsonWithoutCommentCount));
      mockedBuildCommentTree.mockReturnValue(mockTree as any);

      const response = await request(app).get(`/api/videos/${baseName}/details`);

      expect(response.status).toBe(200);
      expect(response.body.details.commentCount).toBe(1);
    });

    it('should handle missing optional fields gracefully', async () => {
      const baseName = '20231201_TestVideo';
      const minimalInfoJson: VideoInfoJson = {
        title: 'Minimal Video',
      };

      mockedGetVideos.mockResolvedValue([mockVideo]);
      mockedFs.access.mockResolvedValue(undefined);
      mockedFs.readFile.mockResolvedValue(JSON.stringify(minimalInfoJson));
      mockedBuildCommentTree.mockReturnValue([]);

      const response = await request(app).get(`/api/videos/${baseName}/details`);

      expect(response.status).toBe(200);
      expect(response.body.details).toMatchObject({
        title: 'Minimal Video',
        description: 'Minimal Video',
        uploadDate: '',
        duration: '',
        viewCount: 0,
        likeCount: 0,
        channelName: '',
        comments: [],
        commentCount: 0,
      });
    });
  });
});
