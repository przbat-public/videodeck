import * as fs from 'node:fs/promises';
import path from 'node:path';
import type { CommentWithReplies, ReindexStatus, VideoComment, VideoListItem } from '@videodeck/shared/api';
import {
  ChannelsResponseSchema,
  CommentsResponseSchema,
  RecreateIndicesStatusSchema,
  ReindexStatusSchema,
  SearchResponseSchema,
  VideoDetailsResponseSchema,
  VideoSummaryResponseSchema,
} from '@videodeck/shared/schemas';
import express from 'express';
import request from 'supertest';
import { createApp } from '../app';
import { loadCommentTree } from '../services/commentStore';
import {
  getRecreateIndicesStatus,
  getVideoByBaseName,
  getVideoByFilePath,
  getVideoByVideoId,
  isRecreateIndicesRunning,
  listChannelNames,
  recreateAllIndices,
} from '../services/elasticsearchService';
import { getFolderPathsForCategory, listCategories } from '../services/folderConfig';
import { generateSummary, SummaryUnavailableError } from '../services/summaryService';
import { getReindexStatus, getVideos, isReindexRunning, refreshVideosCache } from '../services/videoScanner';
import type { VideoInfoJson } from '../types';
import { buildCommentTree } from '../utils/commentTreeUtils';
import { getVideoFilePath } from '../utils/videoPathUtils';

jest.mock('../services/videoScanner');
// Only the file-path join is mocked; normalizeFolderPath must stay real
// (the router compares folder paths against the allowed list with it)
jest.mock('../utils/videoPathUtils', () => ({
  ...jest.requireActual('../utils/videoPathUtils'),
  getVideoFilePath: jest.fn(),
}));
jest.mock('../utils/commentTreeUtils');
jest.mock('node:fs/promises');
jest.mock('../services/elasticsearchService');
jest.mock('../services/folderConfig');
jest.mock('../services/summaryService');
jest.mock('../services/commentStore', () => ({
  loadCommentTree: jest.fn(),
}));
jest.mock('../config', () => ({
  ...jest.requireActual('../config'),
  getVideosFolderPaths: () => ['/test/videos', '/test/other'],
}));

const mockedGetVideos = getVideos as jest.MockedFunction<typeof getVideos>;
const mockedGetVideoFilePath = getVideoFilePath as jest.MockedFunction<typeof getVideoFilePath>;
const mockedBuildCommentTree = buildCommentTree as jest.MockedFunction<typeof buildCommentTree>;
const mockedFs = fs as jest.Mocked<typeof fs>;
const mockedRefreshVideosCache = refreshVideosCache as jest.MockedFunction<typeof refreshVideosCache>;
const mockedGetReindexStatus = getReindexStatus as jest.MockedFunction<typeof getReindexStatus>;
const mockedIsReindexRunning = isReindexRunning as jest.MockedFunction<typeof isReindexRunning>;
const mockedRecreateAllIndices = recreateAllIndices as jest.MockedFunction<typeof recreateAllIndices>;
const mockedIsRecreateIndicesRunning = isRecreateIndicesRunning as jest.MockedFunction<typeof isRecreateIndicesRunning>;
const mockedGetRecreateIndicesStatus = getRecreateIndicesStatus as jest.MockedFunction<typeof getRecreateIndicesStatus>;
const mockedGetVideoByBaseName = getVideoByBaseName as jest.MockedFunction<typeof getVideoByBaseName>;
const mockedGetVideoByVideoId = getVideoByVideoId as jest.MockedFunction<typeof getVideoByVideoId>;
const mockedGetVideoByFilePath = getVideoByFilePath as jest.MockedFunction<typeof getVideoByFilePath>;
const mockedListChannelNames = listChannelNames as jest.MockedFunction<typeof listChannelNames>;
const mockedLoadCommentTree = loadCommentTree as jest.MockedFunction<typeof loadCommentTree>;
const mockedGetFolderPathsForCategory = getFolderPathsForCategory as jest.MockedFunction<
  typeof getFolderPathsForCategory
>;
const mockedListCategories = listCategories as jest.MockedFunction<typeof listCategories>;
const mockedGenerateSummary = generateSummary as jest.MockedFunction<typeof generateSummary>;

describe('videos router', () => {
  let app: express.Application;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    // Silence console output during tests (the spy is asserted against later)
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {
      /* silence expected error logs */
    });
    jest.spyOn(console, 'log').mockImplementation(() => {
      /* silence expected info logs */
    });
    // Defaults for the real fs mocks: access/realpath succeed
    mockedFs.access.mockResolvedValue(undefined);
    mockedFs.realpath.mockImplementation((p) => Promise.resolve(String(p)));

    app = createApp();
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

      mockedGetVideos.mockResolvedValue({ videos: mockVideos, total: 100 });

      const response = await request(app).get('/api/videos/search?q=test');

      expect(response.status).toBe(200);
      expect(SearchResponseSchema.parse(response.body)).toEqual({
        videos: mockVideos,
        totalCount: 100,
      });
      expect(mockedGetVideos).toHaveBeenCalledWith('test', 'date-desc', undefined, {
        offset: 0,
        limit: 100,
      });
    });

    it('passes the channel filter to the search service and ignores the legacy date params', async () => {
      mockedGetVideos.mockResolvedValue({ videos: [], total: 0 });

      const response = await request(app).get(
        '/api/videos/search?q=x&channel=Jordan%20B%20Peterson&dateFrom=2024-01-05&dateTo=2025-12-31',
      );

      expect(response.status).toBe(200);
      expect(mockedGetVideos).toHaveBeenCalledWith('x', 'date-desc', undefined, {
        offset: 0,
        limit: 100,
        channel: 'Jordan B Peterson',
      });
    });

    it('lists distinct channel names for the filter UI', async () => {
      mockedListChannelNames.mockResolvedValue({
        channels: ['Alpha', 'Beta'],
        folders: { '/videos/a': 'Alpha' },
      });

      const response = await request(app).get('/api/videos/channels');

      expect(response.status).toBe(200);
      expect(ChannelsResponseSchema.parse(response.body)).toEqual({
        channels: ['Alpha', 'Beta'],
        folders: { '/videos/a': 'Alpha' },
      });
    });

    it('should use default sort when sort parameter is not provided', async () => {
      const mockVideos: VideoListItem[] = [];
      mockedGetVideos.mockResolvedValue({ videos: mockVideos, total: 0 });

      const response = await request(app).get('/api/videos/search?q=test');

      expect(response.status).toBe(200);
      expect(mockedGetVideos).toHaveBeenCalledWith('test', 'date-desc', undefined, {
        offset: 0,
        limit: 100,
      });
    });

    it('should use provided sort parameter', async () => {
      const mockVideos: VideoListItem[] = [];
      mockedGetVideos.mockResolvedValue({ videos: mockVideos, total: 0 });

      const response = await request(app).get('/api/videos/search?q=test&sort=views-desc');

      expect(response.status).toBe(200);
      expect(mockedGetVideos).toHaveBeenCalledWith('test', 'views-desc', undefined, {
        offset: 0,
        limit: 100,
      });
    });

    it('accepts relevance as a sort option', async () => {
      mockedGetVideos.mockResolvedValue({ videos: [], total: 0 });

      const response = await request(app).get('/api/videos/search?q=test&sort=relevance');

      expect(response.status).toBe(200);
      expect(mockedGetVideos).toHaveBeenCalledWith('test', 'relevance', undefined, {
        offset: 0,
        limit: 100,
      });
    });

    it('passes offset and limit through to the search', async () => {
      mockedGetVideos.mockResolvedValue({ videos: [], total: 0 });

      await request(app).get('/api/videos/search?q=test&offset=200&limit=25');

      expect(mockedGetVideos).toHaveBeenCalledWith('test', 'date-desc', undefined, {
        offset: 200,
        limit: 25,
      });
    });

    it('falls back to defaults for malformed offset and limit', async () => {
      mockedGetVideos.mockResolvedValue({ videos: [], total: 0 });

      await request(app).get('/api/videos/search?q=test&offset=abc&limit=-5');

      expect(mockedGetVideos).toHaveBeenCalledWith('test', 'date-desc', undefined, {
        offset: 0,
        limit: 100,
      });
    });

    it('falls back to the default sort for unknown or repeated sort values', async () => {
      mockedGetVideos.mockResolvedValue({ videos: [], total: 0 });

      await request(app).get('/api/videos/search?q=test&sort=title-asc');
      expect(mockedGetVideos).toHaveBeenLastCalledWith('test', 'date-desc', undefined, {
        offset: 0,
        limit: 100,
      });

      await request(app).get('/api/videos/search?q=test&sort=views-desc&sort=likes-asc');
      expect(mockedGetVideos).toHaveBeenLastCalledWith('test', 'date-desc', undefined, {
        offset: 0,
        limit: 100,
      });
    });

    it('should handle empty query', async () => {
      const mockVideos: VideoListItem[] = [];
      mockedGetVideos.mockResolvedValue({ videos: mockVideos, total: 0 });

      const response = await request(app).get('/api/videos/search');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ videos: mockVideos, totalCount: 0 });
      expect(mockedGetVideos).toHaveBeenCalledWith(undefined, 'date-desc', undefined, {
        offset: 0,
        limit: 100,
      });
    });

    it('should handle errors from getVideos', async () => {
      const error = new Error('Failed to load videos');
      mockedGetVideos.mockRejectedValue(error);

      const response = await request(app).get('/api/videos/search?q=test');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        error: 'Internal server error',
      });
    });

    it('should handle non-Error exceptions', async () => {
      mockedGetVideos.mockRejectedValue('String error');

      const response = await request(app).get('/api/videos/search?q=test');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        error: 'Internal server error',
      });
    });

    it('limits the search to the folders of the requested category', async () => {
      mockedGetVideos.mockResolvedValue({ videos: [], total: 12 });
      mockedGetFolderPathsForCategory.mockResolvedValue(['/test/videos']);

      const response = await request(app).get('/api/videos/search?q=test&category=%20fpv%20');

      expect(response.status).toBe(200);
      expect(mockedGetFolderPathsForCategory).toHaveBeenCalledWith('fpv');
      expect(mockedGetVideos).toHaveBeenCalledWith('test', 'date-desc', ['/test/videos'], {
        offset: 0,
        limit: 100,
      });
      expect(response.body.totalCount).toBe(12);
    });

    it('returns nothing for a category no folder declares', async () => {
      mockedGetVideos.mockResolvedValue({ videos: [], total: 0 });
      mockedGetFolderPathsForCategory.mockResolvedValue([]);

      const response = await request(app).get('/api/videos/search?category=nope');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ videos: [], totalCount: 0 });
      expect(mockedGetVideos).toHaveBeenCalledWith(undefined, 'date-desc', [], {
        offset: 0,
        limit: 100,
      });
    });

    it('ignores a blank category instead of matching nothing', async () => {
      mockedGetVideos.mockResolvedValue({ videos: [], total: 0 });

      await request(app).get('/api/videos/search?category=%20%20');

      expect(mockedGetFolderPathsForCategory).not.toHaveBeenCalled();
      expect(mockedGetVideos).toHaveBeenCalledWith(undefined, 'date-desc', undefined, {
        offset: 0,
        limit: 100,
      });
    });
  });

  describe('GET /api/videos/categories', () => {
    it('returns the categories declared in the folder configs', async () => {
      mockedListCategories.mockResolvedValue(['fpv', 'psychology']);

      const response = await request(app).get('/api/videos/categories');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ categories: ['fpv', 'psychology'] });
    });

    it('reports failures as 500', async () => {
      mockedListCategories.mockRejectedValue(new Error('disk gone'));

      const response = await request(app).get('/api/videos/categories');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Internal server error' });
    });
  });

  describe('POST /api/videos/refreshCache', () => {
    it('should start cache refresh process and return immediately', async () => {
      mockedRefreshVideosCache.mockResolvedValue(undefined);

      const response = await request(app).post('/api/videos/refreshCache');

      expect(response.status).toBe(202);
      expect(response.body).toEqual({
        message: 'Cache refresh process started',
        status: 'ok',
      });
      expect(mockedRefreshVideosCache).toHaveBeenCalled();
    });

    it('passes onlyMissing=1 so cached folders are skipped', async () => {
      mockedRefreshVideosCache.mockResolvedValue(undefined);

      const response = await request(app).post('/api/videos/refreshCache?onlyMissing=1');

      expect(response.status).toBe(202);
      expect(mockedRefreshVideosCache).toHaveBeenCalledWith({ onlyMissing: true });
    });

    it('should handle errors in background without affecting response', async () => {
      const error = new Error('Failed to refresh');
      mockedRefreshVideosCache.mockRejectedValue(error);

      const response = await request(app).post('/api/videos/refreshCache');

      // Response should still be 200 because errors are handled in background
      expect(response.status).toBe(202);
      expect(response.body).toEqual({
        message: 'Cache refresh process started',
        status: 'ok',
      });
      expect(mockedRefreshVideosCache).toHaveBeenCalled();

      // Wait a bit for the catch handler to execute
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Error refreshing cache in background:'),
        error,
      );
    });

    it('returns 409 with the current status when a reindex is already running', async () => {
      const running: ReindexStatus = {
        running: true,
        foldersDone: 2,
        foldersTotal: 5,
        filesDone: 10,
        filesTotal: 100,
        indexed: 40,
        skipped: 1,
        errors: [],
      };
      mockedIsReindexRunning.mockReturnValue(true);
      mockedGetReindexStatus.mockReturnValue(running);

      const response = await request(app).post('/api/videos/refreshCache');

      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({ error: 'Reindex already running', status: running });
      expect(mockedRefreshVideosCache).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/videos/refreshCache/status', () => {
    it('returns the reindex status', async () => {
      const status = {
        running: true,
        startedAt: '2025-01-01T00:00:00.000Z',
        currentFolder: '/test/videos',
        foldersDone: 1,
        foldersTotal: 3,
        filesDone: 40,
        filesTotal: 120,
        indexed: 140,
        skipped: 2,
        errors: [],
      };
      mockedGetReindexStatus.mockReturnValue(status);

      const response = await request(app).get('/api/videos/refreshCache/status');

      expect(response.status).toBe(200);
      expect(ReindexStatusSchema.parse(response.body)).toEqual(status);
    });
  });

  describe('POST /api/videos/recreateIndices', () => {
    it('should start indices recreation process and return immediately', async () => {
      mockedRecreateAllIndices.mockResolvedValue(undefined);

      const response = await request(app).post('/api/videos/recreateIndices');

      expect(response.status).toBe(202);
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

      // Response should still be 202 because errors are handled in background
      expect(response.status).toBe(202);
      expect(response.body).toEqual({
        message: 'Indices recreation process started',
        status: 'ok',
      });
      expect(mockedRecreateAllIndices).toHaveBeenCalled();

      // Wait a bit for the catch handler to execute
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Error recreating indices in background:'),
        error,
      );
    });

    it('should return 409 when a recreation is already running', async () => {
      mockedIsRecreateIndicesRunning.mockReturnValue(true);

      const response = await request(app).post('/api/videos/recreateIndices');

      expect(response.status).toBe(409);
      expect(response.body).toEqual({
        error: 'Index recreation already running',
        message: 'Index recreation is already in progress',
      });
      expect(mockedRecreateAllIndices).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/videos/recreateIndices/status', () => {
    it('should return the current recreation status', async () => {
      const status = {
        running: false,
        startedAt: '2025-01-01T10:00:00.000Z',
        finishedAt: '2025-01-01T10:01:00.000Z',
        foldersDone: 2,
        foldersTotal: 2,
        errors: [],
      };
      mockedGetRecreateIndicesStatus.mockReturnValue(status);

      const response = await request(app).get('/api/videos/recreateIndices/status');

      expect(response.status).toBe(200);
      expect(RecreateIndicesStatusSchema.parse(response.body)).toEqual(status);
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
      // The route calls sendFile(path) only, so the options/callback overload is not needed
      sendFileSpy = jest.spyOn(express.response, 'sendFile').mockImplementation(function (
        this: express.Response,
        filePath: string,
      ) {
        // Set content-type header that would normally be set
        const ext = path.extname(filePath.toString()).toLowerCase();
        if (ext === '.mp4') {
          this.setHeader('Content-Type', 'video/mp4');
        } else if (ext === '.webp') {
          this.setHeader('Content-Type', 'image/webp');
        } else if (ext === '.vtt') {
          this.setHeader('Content-Type', 'text/vtt; charset=utf-8');
        } else {
          this.setHeader('Content-Type', 'application/octet-stream');
        }
        // End the response to prevent hanging
        this.status(200).end();
      });
    });

    afterEach(() => {
      sendFileSpy.mockRestore();
    });

    it('should serve video file (.mp4)', async () => {
      const filename = '20231201_TestVideo.mp4';
      const mockFilePath = '/test/videos/20231201_TestVideo.mp4';

      mockedGetVideoByFilePath.mockResolvedValue(mockVideo);
      mockedGetVideoFilePath.mockReturnValue(mockFilePath);
      mockedFs.realpath.mockImplementation((p) => Promise.resolve(String(p)));

      const response = await request(app).get(`/api/videos/file/${filename}`);

      expect(response.status).toBe(200);
      expect(mockedGetVideoByFilePath).toHaveBeenCalledWith(filename);
      expect(mockedGetVideoFilePath).toHaveBeenCalledWith(filename, '/test/videos');
      expect(mockedFs.realpath).toHaveBeenCalledWith(mockFilePath);
    });

    it('should serve thumbnail file (.webp)', async () => {
      const filename = '20231201_TestVideo.webp';
      const mockFilePath = '/test/videos/20231201_TestVideo.webp';

      mockedGetVideoByFilePath.mockResolvedValue(mockVideo);
      mockedGetVideoFilePath.mockReturnValue(mockFilePath);
      mockedFs.realpath.mockImplementation((p) => Promise.resolve(String(p)));

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

      mockedGetVideoByFilePath.mockResolvedValue(videoWithMatchingPath);
      mockedGetVideoFilePath.mockReturnValue(mockFilePath);
      mockedFs.realpath.mockImplementation((p) => Promise.resolve(String(p)));

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

      mockedGetVideoByFilePath.mockResolvedValue(videoWithMatchingThumbnail);
      mockedGetVideoFilePath.mockReturnValue(mockFilePath);
      mockedFs.realpath.mockImplementation((p) => Promise.resolve(String(p)));

      await request(app).get(`/api/videos/file/${filename}`);

      expect(mockedGetVideoFilePath).toHaveBeenCalledWith(filename, '/test/videos');
    });

    it('should return 404 when the file is not indexed (no fallback to a guessed folder)', async () => {
      const filename = 'nonexistent.mp4';

      mockedGetVideoByFilePath.mockResolvedValue(null);

      const response = await request(app).get(`/api/videos/file/${filename}`);

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'File not found' });
      expect(mockedGetVideoFilePath).not.toHaveBeenCalled();
    });

    it('should handle file access errors', async () => {
      const filename = 'test.mp4';
      const mockFilePath = '/test/videos/test.mp4';

      mockedGetVideoByFilePath.mockResolvedValue(mockVideo);
      mockedGetVideoFilePath.mockReturnValue(mockFilePath);
      mockedFs.realpath.mockRejectedValue(new Error('Permission denied'));

      const response = await request(app).get(`/api/videos/file/${filename}`);

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'File not found' });
    });

    it('should set correct Content-Type for .mp4 files', async () => {
      const filename = 'test.mp4';
      const mockFilePath = '/test/videos/test.mp4';

      mockedGetVideoByFilePath.mockResolvedValue(mockVideo);
      mockedGetVideoFilePath.mockReturnValue(mockFilePath);
      mockedFs.realpath.mockImplementation((p) => Promise.resolve(String(p)));

      const response = await request(app).get(`/api/videos/file/${filename}`);

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toBe('video/mp4');
      expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    });

    it('should serve subtitle files with cue settings stripped (centered captions)', async () => {
      const filename = 'test.en.vtt';
      const mockFilePath = '/test/videos/test.en.vtt';

      mockedGetVideoByFilePath.mockResolvedValue(mockVideo);
      mockedGetVideoFilePath.mockReturnValue(mockFilePath);
      mockedFs.realpath.mockImplementation((p) => Promise.resolve(String(p)));
      mockedFs.readFile.mockResolvedValue('WEBVTT\n\n00:00:03.360 --> 00:00:05.200 align:start position:0%\ntext\n');

      const response = await request(app).get(`/api/videos/file/${filename}`);

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/vtt');
      // Subtitles change in place on updates — the client must revalidate
      expect(response.headers['cache-control']).toBe('no-cache');
      expect(response.text).toBe('WEBVTT\n\n00:00:03.360 --> 00:00:05.200\ntext\n');
    });

    it('should set correct Content-Type for .webp files', async () => {
      const filename = 'test.webp';
      const mockFilePath = '/test/videos/test.webp';

      mockedGetVideoByFilePath.mockResolvedValue(mockVideo);
      mockedGetVideoFilePath.mockReturnValue(mockFilePath);
      mockedFs.realpath.mockImplementation((p) => Promise.resolve(String(p)));

      const response = await request(app).get(`/api/videos/file/${filename}`);

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toBe('image/webp');
      expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    });

    it('should use default Content-Type for unknown extensions', async () => {
      const filename = 'test.unknown';
      const mockFilePath = '/test/videos/test.unknown';

      mockedGetVideoByFilePath.mockResolvedValue(mockVideo);
      mockedGetVideoFilePath.mockReturnValue(mockFilePath);
      mockedFs.realpath.mockImplementation((p) => Promise.resolve(String(p)));

      const response = await request(app).get(`/api/videos/file/${filename}`);

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toBe('application/octet-stream');
    });

    it('should handle errors during file serving', async () => {
      const filename = 'test.mp4';
      const error = new Error('Failed to read file');

      mockedGetVideoByFilePath.mockResolvedValue(mockVideo);
      mockedGetVideoFilePath.mockImplementation(() => {
        throw error;
      });

      const response = await request(app).get(`/api/videos/file/${filename}`);

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        error: 'Internal server error',
      });
    });

    it('uses the folder query param without hitting Elasticsearch', async () => {
      const filename = '20231201_TestVideo.mp4';
      mockedGetVideoFilePath.mockReturnValue('/test/other/20231201_TestVideo.mp4');
      mockedFs.realpath.mockImplementation((p) => Promise.resolve(String(p)));

      const response = await request(app).get(`/api/videos/file/${filename}`).query({ folder: '/test/other' });

      expect(response.status).toBe(200);
      expect(mockedGetVideoByFilePath).not.toHaveBeenCalled();
      expect(mockedGetVideoFilePath).toHaveBeenCalledWith(filename, '/test/other');
    });

    it('rejects a folder query param that is not configured', async () => {
      const response = await request(app).get('/api/videos/file/test.mp4').query({ folder: '/etc' });

      expect(response.status).toBe(403);
      expect(mockedGetVideoFilePath).not.toHaveBeenCalled();
    });

    it('returns 404 instead of falling back to a guessed folder when the file is not indexed', async () => {
      const filename = 'unindexed.mp4';
      mockedGetVideoByFilePath.mockResolvedValue(null);

      const response = await request(app).get(`/api/videos/file/${filename}`);

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'File not found' });
      expect(mockedGetVideoFilePath).not.toHaveBeenCalled();
    });

    it('returns 404 when the Elasticsearch lookup fails (no guessed fallback)', async () => {
      const filename = 'test.mp4';
      mockedGetVideoByFilePath.mockRejectedValue(new Error('ES down'));

      const response = await request(app).get(`/api/videos/file/${filename}`);

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'File not found' });
      expect(mockedGetVideoFilePath).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/videos/:identifier/summary', () => {
    const mockVideo: VideoListItem = {
      baseName: '20231201_TestVideo',
      videoId: 'testVideoId', // 11 characters to match YouTube ID pattern
      title: 'Test Video',
      description: 'A test video',
      videoPath: '20231201_TestVideo.mp4',
      thumbnailPath: '20231201_TestVideo.webp',
      folderPath: '/test/videos',
      comments: [],
      subtitlePath: '20231201_TestVideo.vtt',
    };

    beforeEach(() => {
      jest.clearAllMocks();
      mockedGetVideoByVideoId.mockResolvedValue(null);
      mockedGetVideoByBaseName.mockResolvedValue(null);
    });

    it('answers 503 with a distinct message when OpenAI is not configured', async () => {
      const baseName = '20231201_TestVideo';
      mockedGetVideoByBaseName.mockResolvedValue(mockVideo);
      mockedGenerateSummary.mockRejectedValue(new SummaryUnavailableError());

      const response = await request(app).get(`/api/videos/${baseName}/summary`);

      expect(response.status).toBe(503);
      expect(response.body).toEqual({ error: 'Summaries are disabled — set OPENAI_API_KEY on the server' });
    });

    it('returns the summary generated by the service (by baseName)', async () => {
      const baseName = '20231201_TestVideo';
      mockedGetVideoByBaseName.mockResolvedValue(mockVideo);
      mockedGenerateSummary.mockResolvedValue({ summary: 'Generated summary', truncated: false });

      const response = await request(app).get(`/api/videos/${baseName}/summary`);

      expect(response.status).toBe(200);
      expect(VideoSummaryResponseSchema.parse(response.body)).toEqual({
        summary: 'Generated summary',
      });
      expect(mockedGetVideoByBaseName).toHaveBeenCalledWith(baseName);
      expect(mockedGenerateSummary).toHaveBeenCalledWith({
        folderPath: '/test/videos',
        baseName,
        subtitlePath: '20231201_TestVideo.vtt',
      });
    });

    it('returns the summary generated by the service (by videoId)', async () => {
      const videoId = 'testVideoId';
      mockedGetVideoByVideoId.mockResolvedValue(mockVideo);
      mockedGenerateSummary.mockResolvedValue({ summary: 'Summary', truncated: false });

      const response = await request(app).get(`/api/videos/${videoId}/summary`);

      expect(response.status).toBe(200);
      expect(mockedGetVideoByVideoId).toHaveBeenCalledWith(videoId);
    });

    it('includes the truncated flag when the service reports it', async () => {
      mockedGetVideoByBaseName.mockResolvedValue(mockVideo);
      mockedGenerateSummary.mockResolvedValue({ summary: 'Cut', truncated: true });

      const response = await request(app).get('/api/videos/20231201_TestVideo/summary');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ summary: 'Cut', truncated: true });
    });

    it('should return 404 when video is not found', async () => {
      mockedGetVideoByBaseName.mockResolvedValue(null);
      mockedGetVideoByVideoId.mockResolvedValue(null);

      const response = await request(app).get('/api/videos/nonexistent/summary');

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'Video not found' });
      expect(mockedGenerateSummary).not.toHaveBeenCalled();
    });

    it('should return 404 when video has no subtitlePath', async () => {
      const { subtitlePath: _subtitlePath, ...videoWithoutSubtitle } = mockVideo;
      mockedGetVideoByBaseName.mockResolvedValue(videoWithoutSubtitle);

      const response = await request(app).get('/api/videos/20231201_TestVideo/summary');

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'Subtitle not found' });
      expect(mockedGenerateSummary).not.toHaveBeenCalled();
    });

    it('turns a failing service into a 500', async () => {
      mockedGetVideoByBaseName.mockResolvedValue(mockVideo);
      mockedGenerateSummary.mockRejectedValue(new Error('OpenAI API error'));

      const response = await request(app).get('/api/videos/20231201_TestVideo/summary');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        error: 'Internal server error',
      });
    });
  });

  describe('GET /api/videos/:identifier/details', () => {
    const mockVideo: VideoListItem = {
      baseName: '20231201_TestVideo',
      videoId: 'testVideoId', // 11 characters to match YouTube ID pattern
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

    beforeEach(() => {
      jest.clearAllMocks();
      // Reset mocks to return null by default
      mockedGetVideoByVideoId.mockResolvedValue(null);
      mockedGetVideoByBaseName.mockResolvedValue(null);
      mockedLoadCommentTree.mockResolvedValue([]);
    });

    it('should return video details (by baseName)', async () => {
      const baseName = '20231201_TestVideo';
      const infoJsonPath = path.join(mockVideo.folderPath, `${baseName}.info.json`);

      mockedGetVideoByBaseName.mockResolvedValue(mockVideo);
      mockedFs.readFile.mockResolvedValue(JSON.stringify(mockInfoJson));
      mockedBuildCommentTree.mockReturnValue([]);

      const response = await request(app).get(`/api/videos/${baseName}/details`);

      expect(response.status).toBe(200);
      expect(VideoDetailsResponseSchema.parse(response.body).details).toMatchObject({
        title: 'Test Video Title',
        description: 'Test Description',
        uploadDate: '20231201',
        duration: '10:30',
        viewCount: 1000,
        likeCount: 50,
        channelName: 'Test Channel',
        comments: [],
        commentCount: 0,
        folderPath: mockVideo.folderPath,
        videoPath: mockVideo.videoPath,
        thumbnailPath: mockVideo.thumbnailPath,
        subtitlePath: mockVideo.subtitlePath,
      });
      expect(mockedGetVideoByBaseName).toHaveBeenCalledWith(baseName);
      expect(mockedFs.readFile).toHaveBeenCalledWith(infoJsonPath, 'utf-8');
      expect(mockedLoadCommentTree).toHaveBeenCalledWith(mockVideo.folderPath, baseName);
    });

    it('should return video details (by videoId)', async () => {
      const videoId = 'testVideoId'; // 11 characters to match YouTube ID pattern
      const infoJsonPath = path.join(mockVideo.folderPath, `${mockVideo.baseName}.info.json`);

      mockedGetVideoByVideoId.mockResolvedValue(mockVideo);
      mockedFs.readFile.mockResolvedValue(JSON.stringify(mockInfoJson));
      mockedBuildCommentTree.mockReturnValue([]);

      const response = await request(app).get(`/api/videos/${videoId}/details`);

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
        commentCount: 0,
        folderPath: mockVideo.folderPath,
        videoPath: mockVideo.videoPath,
        thumbnailPath: mockVideo.thumbnailPath,
        subtitlePath: mockVideo.subtitlePath,
      });
      expect(mockedGetVideoByVideoId).toHaveBeenCalledWith(videoId);
      expect(mockedFs.readFile).toHaveBeenCalledWith(infoJsonPath, 'utf-8');
      expect(mockedLoadCommentTree).toHaveBeenCalledWith(mockVideo.folderPath, mockVideo.baseName);
    });

    it('returns only the first page of comments in details', async () => {
      const baseName = '20231201_TestVideo';
      const many = Array.from({ length: 120 }, (_, i) => ({
        id: `c${i}`,
        text: `comment ${i}`,
      })) as CommentWithReplies[];

      mockedGetVideoByBaseName.mockResolvedValue(mockVideo);
      mockedFs.readFile.mockResolvedValue(JSON.stringify(mockInfoJson));
      mockedLoadCommentTree.mockResolvedValue(many);

      const response = await request(app).get(`/api/videos/${baseName}/details`);

      expect(response.status).toBe(200);
      expect(response.body.details.comments).toHaveLength(50);
      expect(response.body.details.commentCount).toBe(120);
    });

    it('paginates the comment tree', async () => {
      const baseName = '20231201_TestVideo';
      const many = Array.from({ length: 120 }, (_, i) => ({
        id: `c${i}`,
        text: `comment ${i}`,
      })) as CommentWithReplies[];

      mockedGetVideoByBaseName.mockResolvedValueOnce(mockVideo).mockResolvedValueOnce(mockVideo);
      mockedLoadCommentTree.mockResolvedValue(many);

      const first = await request(app).get(`/api/videos/${baseName}/comments?offset=0&limit=50`);
      expect(first.status).toBe(200);
      expect(CommentsResponseSchema.parse(first.body)).toEqual({
        comments: many.slice(0, 50),
        totalCount: 120,
        offset: 0,
      });

      const second = await request(app).get(`/api/videos/${baseName}/comments?offset=50`);
      expect(second.status).toBe(200);
      expect(second.body.comments).toHaveLength(50);
      expect(second.body.comments[0]?.id).toBe('c50');
      expect(second.body.totalCount).toBe(120);

      expect((await request(app).get('/api/videos/nope/comments')).status).toBe(404);
    });

    it('lists every subtitle file of the video with its language', async () => {
      const baseName = '20231201_TestVideo';

      mockedGetVideoByBaseName.mockResolvedValue(mockVideo);
      mockedFs.readFile.mockResolvedValue(JSON.stringify(mockInfoJson));
      mockedFs.readdir.mockResolvedValue([
        '20231201_TestVideo.pl.vtt',
        '20231201_TestVideo.en.vtt',
        '20231201_OtherVideo.en.vtt',
        '20231201_TestVideo.en.json',
      ] as never);
      mockedBuildCommentTree.mockReturnValue([]);

      const response = await request(app).get(`/api/videos/${baseName}/details`);

      expect(response.status).toBe(200);
      expect(response.body.details.subtitles).toEqual([
        { path: '20231201_TestVideo.en.vtt', lang: 'en' },
        { path: '20231201_TestVideo.pl.vtt', lang: 'pl' },
      ]);
    });

    it('should use fulltitle when title is not available', async () => {
      const baseName = '20231201_TestVideo';
      const infoJsonWithoutTitle: VideoInfoJson = {
        fulltitle: 'Full Title Only',
        description: 'Test Description',
      };

      mockedGetVideoByBaseName.mockResolvedValue(mockVideo);
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

      mockedGetVideoByBaseName.mockResolvedValue(mockVideo);
      mockedFs.readFile.mockResolvedValue(JSON.stringify(infoJsonWithoutChannel));
      mockedBuildCommentTree.mockReturnValue([]);

      const response = await request(app).get(`/api/videos/${baseName}/details`);

      expect(response.status).toBe(200);
      expect(response.body.details.channelName).toBe('Test Uploader');
    });

    it('should use duration_string or format numeric duration as clock time', async () => {
      const baseName = '20231201_TestVideo';
      const infoJsonWithNumericDuration: VideoInfoJson = {
        title: 'Test Video',
        duration: 630, // 10:30 in seconds
      };

      mockedGetVideoByBaseName.mockResolvedValue(mockVideo);
      mockedFs.readFile.mockResolvedValue(JSON.stringify(infoJsonWithNumericDuration));
      mockedBuildCommentTree.mockReturnValue([]);

      const response = await request(app).get(`/api/videos/${baseName}/details`);

      expect(response.status).toBe(200);
      expect(response.body.details.duration).toBe('10:30');
    });

    it('should build comment tree from comments', async () => {
      const baseName = '20231201_TestVideo';
      const mockComments: VideoComment[] = [
        { id: '1', text: 'Comment 1', parent: 'root' },
        { id: '2', text: 'Comment 2', parent: '1' },
      ];
      const mockTree: CommentWithReplies[] = [
        { id: '1', text: 'Comment 1', replies: [{ id: '2', text: 'Comment 2' }] },
      ];

      const infoJsonWithComments: VideoInfoJson = {
        title: 'Test Video',
        comments: mockComments,
      };

      mockedGetVideoByBaseName.mockResolvedValue(mockVideo);
      mockedFs.readFile.mockResolvedValue(JSON.stringify(infoJsonWithComments));
      mockedLoadCommentTree.mockResolvedValue(mockTree);

      const response = await request(app).get(`/api/videos/${baseName}/details`);

      expect(response.status).toBe(200);
      expect(mockedLoadCommentTree).toHaveBeenCalledWith(mockVideo.folderPath, baseName);
      expect(response.body.details.comments).toEqual(mockTree);
      expect(response.body.details.commentCount).toBe(mockTree.length);
    });

    it('should return 404 when video is not found', async () => {
      const baseName = 'nonexistent';

      mockedGetVideoByBaseName.mockResolvedValue(null);
      mockedGetVideoByVideoId.mockResolvedValue(null);

      const response = await request(app).get(`/api/videos/${baseName}/details`);

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'Video not found' });
    });

    it('should return 404 when info.json file does not exist', async () => {
      const baseName = '20231201_TestVideo';

      mockedGetVideoByBaseName.mockResolvedValue(mockVideo);
      mockedFs.access.mockRejectedValue(new Error('File not found'));

      const response = await request(app).get(`/api/videos/${baseName}/details`);

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'Video details not found' });
    });

    it('should return 500 for invalid JSON in info.json', async () => {
      const baseName = '20231201_TestVideo';

      mockedGetVideoByBaseName.mockResolvedValue(mockVideo);
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
      const error = new Error('Permission denied');

      mockedGetVideoByBaseName.mockResolvedValue(mockVideo);
      mockedFs.readFile.mockRejectedValue(error);

      const response = await request(app).get(`/api/videos/${baseName}/details`);

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        error: 'Internal server error',
      });
    });

    it('should handle errors when getVideoByBaseName fails', async () => {
      const baseName = '20231201_TestVideo';
      const error = new Error('Failed to load video');

      mockedGetVideoByBaseName.mockRejectedValue(error);

      const response = await request(app).get(`/api/videos/${baseName}/details`);

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        error: 'Internal server error',
      });
    });

    it('should use comments.length as fallback for commentCount', async () => {
      const baseName = '20231201_TestVideo';
      const mockComments: VideoComment[] = [{ id: '1', text: 'Comment 1' }];
      const mockTree: CommentWithReplies[] = [{ id: '1', text: 'Comment 1' }];

      const infoJsonWithoutCommentCount: VideoInfoJson = {
        title: 'Test Video',
        comments: mockComments,
      };

      mockedGetVideoByBaseName.mockResolvedValue(mockVideo);
      mockedFs.readFile.mockResolvedValue(JSON.stringify(infoJsonWithoutCommentCount));
      mockedLoadCommentTree.mockResolvedValue(mockTree);

      const response = await request(app).get(`/api/videos/${baseName}/details`);

      expect(response.status).toBe(200);
      expect(response.body.details.commentCount).toBe(mockTree.length);
    });

    it('should handle missing optional fields gracefully', async () => {
      const baseName = '20231201_TestVideo';
      const minimalInfoJson: VideoInfoJson = {
        title: 'Minimal Video',
      };

      mockedGetVideoByBaseName.mockResolvedValue(mockVideo);
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
