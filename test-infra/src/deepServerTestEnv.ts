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

// test-infra/src → repo root. __dirname is defined under jest (CJS) and is
// shimmed by vite-node alike, so one form serves both runners.
const REPO_ROOT = path.resolve(__dirname, '../..');
export const FAKE_YTDLP = path.join(REPO_ROOT, 'scripts/fake-bin/yt-dlp');

type AppModule = typeof import('../../server/src/app.js');

// Local declaration so both typechecking programs are happy: the server
// program sees the real @types/jest shape, the client program gets a stub.
declare const jest: { requireActual: <T>(path: string) => T } | undefined;

async function loadAppModule(): Promise<AppModule> {
  // typeof probe: jest is undefined under vite-node — a bare reference would throw.
  if (typeof jest !== 'undefined') {
    return jest.requireActual<AppModule>('../../server/src/app');
  }
  return import('../../server/src/app.js');
}

export interface DeepServerTestEnv {
  /** supertest agent bound to the real app */
  agent: ReturnType<typeof request>;
  app: Express;
  /** Base URL of the real HTTP listener (set when options.listen is true) */
  baseUrl?: string;
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

export interface DeepServerTestEnvOptions extends MockOpenaiOptions {
  /** Boot a real HTTP listener on an ephemeral port (client integration) */
  listen?: boolean;
}

export async function createDeepServerTestEnv(options: DeepServerTestEnvOptions = {}): Promise<DeepServerTestEnv> {
  const mockOpenaiOptions: MockOpenaiOptions = {
    ...(options.content === undefined ? {} : { content: options.content }),
    ...(options.rateLimitedModels === undefined ? {} : { rateLimitedModels: options.rateLimitedModels }),
  };
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
  // jest (CJS) cannot run a native dynamic import without ESM flags, while
  // vite-node cannot require() — probe the runtime and use its loader.
  const { createApp } = await loadAppModule();
  const app = createApp();

  // Optional real HTTP listener: the client integration suite points its
  // fetch proxy at it instead of driving the app through supertest.
  const httpServer = options.listen === true ? app.listen(0, '127.0.0.1') : null;
  const baseUrl = httpServer
    ? await new Promise<string>((resolve) => {
        httpServer.once('listening', () => {
          const { port } = httpServer.address() as { port: number };
          resolve(`http://127.0.0.1:${port}`);
        });
      })
    : undefined;

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
    ...(baseUrl === undefined ? {} : { baseUrl }),
    root,
    videosDir,
    fakeEs,
    mockOpenai,
    folder,
    seedFolder,
    setFolders,
    async dispose() {
      if (httpServer) {
        await new Promise<void>((resolve, reject) => httpServer.close((error) => (error ? reject(error) : resolve())));
      }
      await Promise.all([fakeEs.stop(), mockOpenai.stop()]);
      await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    },
  };
}

/** The sidecar files of one downloaded video, as the fake yt-dlp writes them */
export function videoFiles(
  videoId: string,
  title: string,
  infoOverrides: Record<string, unknown> = {},
): Record<string, string> {
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
      ...infoOverrides,
    }),
    [`${base}.en.vtt`]: 'WEBVTT\n\n00:00.000 --> 00:01.000\nDeep test subtitle line.\n',
  };
}

/** A valid folder config.json for the deep environment */
export function folderConfig(channelUrl = 'https://www.youtube.com/@deepchannel', category = 'tests'): string {
  return JSON.stringify({ channelUrl, category });
}
