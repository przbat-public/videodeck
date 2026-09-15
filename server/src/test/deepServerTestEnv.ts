import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Express } from 'express';
import request from 'supertest';
import { FakeElasticsearch } from './fakeElasticsearch';
import type { MockOpenaiOptions } from './mockOpenai';
import { MockOpenai } from './mockOpenai';

/**
 * Boots the REAL Express app with only the external world faked:
 *  - Elasticsearch  → in-process FakeElasticsearch (ELASTICSEARCH_URL)
 *  - OpenAI         → in-process MockOpenai (OPENAI_BASE_URL)
 *  - yt-dlp         → scripts/fake-bin/yt-dlp (YTDLP_PATH)
 *  - video folders  → a temp directory (VIDEOS_FOLDER_PATH)
 *  - queue state    → inside the temp directory (QUEUE_STATE_FILE)
 *
 * The app module is imported dynamically AFTER the environment is set, so
 * the module-level env reads (config.ts) see the test values.
 */

const REPO_ROOT = path.resolve(__dirname, '../../..');
export const FAKE_YTDLP = path.join(REPO_ROOT, 'scripts/fake-bin/yt-dlp');

export interface DeepServerTestEnv {
  /** supertest agent bound to the real app */
  agent: ReturnType<typeof request>;
  app: Express;
  /** Root of the temp environment (videos/ + queue state live here) */
  root: string;
  /** Parent directory the per-test folders live under */
  videosDir: string;
  fakeEs: FakeElasticsearch;
  mockOpenai: MockOpenai;
  /** Path of a folder under videos/ (created lazily by seedFolder) */
  folder(name: string): string;
  /** Create a folder under videos/ and write the given files into it */
  seedFolder(name: string, files: Record<string, string>): Promise<string>;
  /** Point VIDEOS_FOLDER_PATH at the named folders (config caches per raw value) */
  setFolders(...names: string[]): void;
  dispose(): Promise<void>;
}

export async function createDeepServerTestEnv(mockOpenaiOptions: MockOpenaiOptions = {}): Promise<DeepServerTestEnv> {
  // realpath: macOS tmpdir lives under /private via a symlink — canonical
  // paths keep every consumer (config, queue, routes) comparing equal paths.
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'videodeck-deep-')));
  const videosDir = path.join(root, 'videos');
  await fs.mkdir(videosDir, { recursive: true });

  const fakeEs = new FakeElasticsearch();
  const mockOpenai = new MockOpenai(mockOpenaiOptions);
  const [esUrl, openaiUrl] = await Promise.all([fakeEs.start(), mockOpenai.start()]);

  process.env.ELASTICSEARCH_URL = esUrl;
  process.env.OPENAI_BASE_URL = openaiUrl;
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.YTDLP_PATH = FAKE_YTDLP;
  process.env.QUEUE_STATE_FILE = path.join(root, '.queue-state.json');

  // Import after the environment is set (config.ts pins env values at load).
  // jest.requireActual keeps the CommonJS resolution the rest of the server
  // uses (a dynamic ESM import would need the .js extension under NodeNext).
  const { createApp } = jest.requireActual('../app') as typeof import('../app');
  const app = createApp();

  const folder = (name: string): string => path.join(videosDir, name);
  const seedFolder = async (name: string, files: Record<string, string>): Promise<string> => {
    const folderPath = folder(name);
    await fs.mkdir(folderPath, { recursive: true });
    for (const [fileName, content] of Object.entries(files)) {
      await fs.writeFile(path.join(folderPath, fileName), content);
    }
    return folderPath;
  };
  const setFolders = (...names: string[]): void => {
    process.env.VIDEOS_FOLDER_PATH = names.map(folder).join(';');
  };

  return {
    agent: request(app),
    app,
    root,
    videosDir,
    fakeEs,
    mockOpenai,
    folder,
    seedFolder,
    setFolders,
    async dispose() {
      await Promise.all([fakeEs.stop(), mockOpenai.stop()]);
      await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    },
  };
}

/** The sidecar files of one downloaded video, as the fake yt-dlp writes them */
export function videoFiles(videoId: string, title: string): Record<string, string> {
  const base = `20260101_${title}`;
  return {
    [`${base}.mp4`]: 'fake-mp4-bytes',
    [`${base}.webp`]: 'fake-webp',
    [`${base}.info.json`]: JSON.stringify({
      id: videoId,
      title,
      upload_date: '20260101',
      duration: 42,
      view_count: 1234,
      like_count: 56,
      channel: 'Deep test channel',
      description: 'Deep test description.',
      webpage_url: `https://www.youtube.com/watch?v=${videoId}`,
    }),
    [`${base}.en.vtt`]: 'WEBVTT\n\n00:00.000 --> 00:01.000\nDeep test subtitle line.\n',
  };
}

/** A valid folder config.json for the deep environment */
export function folderConfig(channelUrl = 'https://www.youtube.com/@deepchannel'): string {
  return JSON.stringify({ channelUrl, category: 'tests' });
}
