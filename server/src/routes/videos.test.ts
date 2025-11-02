import request from 'supertest';
import express from 'express';
import videosRouter from './videos';
import { getVideos } from '../services/videoScanner';
import { getVideoFilePath } from '../utils/videoPathUtils';
import { buildCommentTree } from '../utils/commentTreeUtils';
import * as fs from 'fs/promises';
import path from 'path';
import { VideoListItem, VideoInfoJson } from '../types';

jest.mock('../services/videoScanner');
jest.mock('../utils/videoPathUtils');
jest.mock('../utils/commentTreeUtils');
jest.mock('fs/promises');

const mockedGetVideos = getVideos as jest.MockedFunction<typeof getVideos>;
const mockedGetVideoFilePath = getVideoFilePath as jest.MockedFunction<typeof getVideoFilePath>;
const mockedBuildCommentTree = buildCommentTree as jest.MockedFunction<typeof buildCommentTree>;
const mockedFs = fs as jest.Mocked<typeof fs>;

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
        },
      ];

      mockedGetVideos.mockReturnValue(mockVideos);

      const response = await request(app).get('/api/videos/search?q=test');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ videos: mockVideos });
      expect(mockedGetVideos).toHaveBeenCalledWith('test', 'date-desc');
    });

    it('should use default sort when sort parameter is not provided', async () => {
      const mockVideos: VideoListItem[] = [];
      mockedGetVideos.mockReturnValue(mockVideos);

      const response = await request(app).get('/api/videos/search?q=test');

      expect(response.status).toBe(200);
      expect(mockedGetVideos).toHaveBeenCalledWith('test', 'date-desc');
    });

    it('should use provided sort parameter', async () => {
      const mockVideos: VideoListItem[] = [];
      mockedGetVideos.mockReturnValue(mockVideos);

      const response = await request(app).get('/api/videos/search?q=test&sort=title-asc');

      expect(response.status).toBe(200);
      expect(mockedGetVideos).toHaveBeenCalledWith('test', 'title-asc');
    });

    it('should handle empty query', async () => {
      const mockVideos: VideoListItem[] = [];
      mockedGetVideos.mockReturnValue(mockVideos);

      const response = await request(app).get('/api/videos/search');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ videos: mockVideos });
      expect(mockedGetVideos).toHaveBeenCalledWith(undefined, 'date-desc');
    });

    it('should handle errors from getVideos', async () => {
      const error = new Error('Failed to load videos');
      mockedGetVideos.mockImplementation(() => {
        throw error;
      });

      const response = await request(app).get('/api/videos/search?q=test');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        error: 'Failed to search videos',
        message: 'Failed to load videos',
      });
    });

    it('should handle non-Error exceptions', async () => {
      mockedGetVideos.mockImplementation(() => {
        throw 'String error';
      });

      const response = await request(app).get('/api/videos/search?q=test');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        error: 'Failed to search videos',
        message: 'Unknown error',
      });
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

      mockedGetVideos.mockReturnValue([mockVideo]);
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

      mockedGetVideos.mockReturnValue([mockVideo]);
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

      mockedGetVideos.mockReturnValue([videoWithMatchingPath]);
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

      mockedGetVideos.mockReturnValue([videoWithMatchingThumbnail]);
      mockedGetVideoFilePath.mockReturnValue(mockFilePath);
      mockedFs.access.mockResolvedValue(undefined);

      await request(app).get(`/api/videos/file/${filename}`);

      expect(mockedGetVideoFilePath).toHaveBeenCalledWith(filename, '/test/videos');
    });

    it('should return 404 when file does not exist', async () => {
      const filename = 'nonexistent.mp4';
      const mockFilePath = '/test/videos/nonexistent.mp4';

      mockedGetVideos.mockReturnValue([]);
      mockedGetVideoFilePath.mockReturnValue(mockFilePath);
      mockedFs.access.mockRejectedValue(new Error('File not found'));

      const response = await request(app).get(`/api/videos/file/${filename}`);

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'File not found' });
    });

    it('should handle file access errors', async () => {
      const filename = 'test.mp4';
      const mockFilePath = '/test/videos/test.mp4';

      mockedGetVideos.mockReturnValue([mockVideo]);
      mockedGetVideoFilePath.mockReturnValue(mockFilePath);
      mockedFs.access.mockRejectedValue(new Error('Permission denied'));

      const response = await request(app).get(`/api/videos/file/${filename}`);

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'File not found' });
    });

    it('should set correct Content-Type for .mp4 files', async () => {
      const filename = 'test.mp4';
      const mockFilePath = '/test/videos/test.mp4';

      mockedGetVideos.mockReturnValue([mockVideo]);
      mockedGetVideoFilePath.mockReturnValue(mockFilePath);
      mockedFs.access.mockResolvedValue(undefined);

      const response = await request(app).get(`/api/videos/file/${filename}`);

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toBe('video/mp4');
    });

    it('should set correct Content-Type for .webp files', async () => {
      const filename = 'test.webp';
      const mockFilePath = '/test/videos/test.webp';

      mockedGetVideos.mockReturnValue([mockVideo]);
      mockedGetVideoFilePath.mockReturnValue(mockFilePath);
      mockedFs.access.mockResolvedValue(undefined);

      const response = await request(app).get(`/api/videos/file/${filename}`);

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toBe('image/webp');
    });

    it('should use default Content-Type for unknown extensions', async () => {
      const filename = 'test.unknown';
      const mockFilePath = '/test/videos/test.unknown';

      mockedGetVideos.mockReturnValue([mockVideo]);
      mockedGetVideoFilePath.mockReturnValue(mockFilePath);
      mockedFs.access.mockResolvedValue(undefined);

      const response = await request(app).get(`/api/videos/file/${filename}`);

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toBe('application/octet-stream');
    });

    it('should handle errors during file serving', async () => {
      const filename = 'test.mp4';
      const error = new Error('Failed to read file');

      mockedGetVideos.mockReturnValue([mockVideo]);
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

      mockedGetVideos.mockReturnValue([mockVideo]);
      mockedGetVideoFilePath.mockReturnValue(mockFilePath);
      mockedFs.access.mockResolvedValue(undefined);

      await request(app).get(`/api/videos/file/${filename}`);

      expect(console.log).toHaveBeenCalledWith('Received filename:', filename);

      process.env.NODE_ENV = originalEnv;
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

      mockedGetVideos.mockReturnValue([mockVideo]);
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

      mockedGetVideos.mockReturnValue([mockVideo]);
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

      mockedGetVideos.mockReturnValue([mockVideo]);
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

      mockedGetVideos.mockReturnValue([mockVideo]);
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

      mockedGetVideos.mockReturnValue([mockVideo]);
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

      mockedGetVideos.mockReturnValue([]);

      const response = await request(app).get(`/api/videos/${baseName}/details`);

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'Video not found' });
    });

    it('should return 404 when info.json file does not exist', async () => {
      const baseName = '20231201_TestVideo';

      mockedGetVideos.mockReturnValue([mockVideo]);
      mockedFs.access.mockRejectedValue(new Error('File not found'));

      const response = await request(app).get(`/api/videos/${baseName}/details`);

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'Video details not found' });
    });

    it('should return 500 for invalid JSON in info.json', async () => {
      const baseName = '20231201_TestVideo';
      const infoJsonPath = path.join(mockVideo.folderPath, `${baseName}.info.json`);

      mockedGetVideos.mockReturnValue([mockVideo]);
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

      mockedGetVideos.mockReturnValue([mockVideo]);
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

      mockedGetVideos.mockImplementation(() => {
        throw error;
      });

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

      mockedGetVideos.mockReturnValue([mockVideo]);
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

      mockedGetVideos.mockReturnValue([mockVideo]);
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
