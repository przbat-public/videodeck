import { existsSync, readFileSync } from 'node:fs';
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
 *  - DeepSeek       → the same MockOpenai (DEEPSEEK_BASE_URL)
 *  - yt-dlp         → scripts/fake-bin/yt-dlp (YTDLP_PATH)
 *  - video folders  → a temp directory (VIDEOS_FOLDER_PATH)
 *  - queue state    → inside the temp directory (QUEUE_STATE_FILE)
 *
 * The app module is imported dynamically AFTER the environment is set, so
 * the module-level env reads (config.ts) see the test values. A suite that
 * imports a server module before this runs gets the cached copy, which still
 * holds what it read back then, so the boot compares those values with its
 * own and refuses on any difference.
 */

// test-infra/src → repo root. vite-node shims __dirname for the ESM transform,
// so the server suite and the client integration suite resolve it alike.
const REPO_ROOT = path.resolve(__dirname, '../..');
export const FAKE_YTDLP = path.join(REPO_ROOT, 'scripts/fake-bin/yt-dlp');

/**
 * File the fake yt-dlp appends its cwd + argv to when it exists in the folder
 * a run starts from. Seed it through `seedFolder` to record what the queue
 * handed to the process boundary; see scripts/fake-bin/yt-dlp.
 */
export const YTDLP_ARGV_LOG_NAME = '.fake-ytdlp-argv.jsonl';

/**
 * File the fake yt-dlp reads its titles from (`{ "<id>": "<title>" }`) when it
 * exists in the folder a run starts from; a video it does not list is titled
 * `Fake video <id>`. Seed it to download videos whose names would collide.
 */
export const YTDLP_TITLES_NAME = '.fake-ytdlp-titles.json';

type AppModule = typeof import('../../server/src/app.js');
type ConfigModule = typeof import('../../server/src/config.js');
type DownloadQueueModule = typeof import('../../server/src/services/downloadQueue.js');
type FolderRoutesModule = typeof import('../../server/src/routes/folder.js');
type IndexMaintenanceModule = typeof import('../../server/src/routes/videos/indexMaintenance.js');
type LibraryStateModule = typeof import('../../server/src/services/libraryState.js');

const loadAppModule = async (): Promise<AppModule> => import('../../server/src/app.js');

const loadConfigModule = async (): Promise<ConfigModule> => import('../../server/src/config.js');

const loadDownloadQueueModule = async (): Promise<DownloadQueueModule> =>
  import('../../server/src/services/downloadQueue.js');

/** The server values read once, when their module loads, that this environment sets */
const LOAD_TIME_VALUES = ['ELASTICSEARCH_URL', 'YTDLP_PATH', 'QUEUE_STATE_FILE'] as const;

type LoadTimeValues = Record<(typeof LOAD_TIME_VALUES)[number], string>;

/**
 * Each load-time value the app holds that differs from the one this
 * environment set, as `NAME=held (set: wanted)`. A difference means a test
 * file imported a server module before createDeepServerTestEnv ran.
 */
async function findPinnedValues(wanted: LoadTimeValues): Promise<string[]> {
  const [config, queue] = await Promise.all([loadConfigModule(), loadDownloadQueueModule()]);
  const held: LoadTimeValues = {
    ELASTICSEARCH_URL: config.ELASTICSEARCH_URL,
    YTDLP_PATH: queue.YTDLP_PATH,
    QUEUE_STATE_FILE: queue.QUEUE_STATE_FILE,
  };
  return LOAD_TIME_VALUES.filter((name) => held[name] !== wanted[name]).map(
    (name) => `${name}=${held[name]} (set: ${wanted[name]})`,
  );
}

const loadFolderRoutesModule = async (): Promise<FolderRoutesModule> => import('../../server/src/routes/folder.js');

const loadIndexMaintenanceModule = async (): Promise<IndexMaintenanceModule> =>
  import('../../server/src/routes/videos/indexMaintenance.js');

const loadLibraryStateModule = async (): Promise<LibraryStateModule> =>
  import('../../server/src/services/libraryState.js');

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
  /**
   * Write the given files into a folder under videos/. A folder that is not
   * there yet arrives with them in one rename, as a drive does; one that is
   * there is written in place.
   */
  seedFolder(name: string, files: Record<string, string>): Promise<string>;
  /** Point VIDEOS_FOLDER_PATH at the named folders (config caches per raw value) */
  setFolders(...names: string[]): void;
  /**
   * Treat every folder under videos/ as the library, so a folder created
   * while the app runs is a drive arriving rather than a stray directory.
   * The snapshot is rebuilt and the watcher re-armed before this returns.
   */
  watchVideosDir(): void;
  /**
   * Every yt-dlp invocation that started in `folderPath`, oldest first, as the
   * process boundary saw it (cwd + argv). Only recorded for folders seeded
   * with `YTDLP_ARGV_LOG_NAME`.
   */
  ytDlpCalls(folderPath: string): Array<{ cwd: string; args: string[] }>;
  /**
   * Forget the server's module-level state: the 5 s `/api/status` body, the
   * summary cache and the index-maintenance flag. It outlives a test because
   * the app is booted in-process, exactly like the client's own store does,
   * and a suite reaching the app only over HTTP cannot clear it otherwise.
   */
  resetServerState(): Promise<void>;
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
  // Both providers reach the same mock, so a test may switch with one variable.
  process.env.DEEPSEEK_BASE_URL = openaiUrl;
  // The DeepSeek key wins over the OpenAI one by design (that is the switch),
  // so a key exported in the developer's shell would move every suite onto
  // DeepSeek. An empty value reads as "no key", and no .env refills it: only
  // the server entry point (index.ts) loads that file, and no suite imports
  // it. A test that wants DeepSeek sets its own.
  process.env.DEEPSEEK_API_KEY = '';
  process.env.DEEPSEEK_MODEL = '';
  process.env.SUMMARY_PROVIDER = '';
  process.env.YTDLP_PATH = FAKE_YTDLP;
  const queueStateFile = path.join(root, '.queue-state.json');
  process.env.QUEUE_STATE_FILE = queueStateFile;
  // The environment's own folder set, before any test narrows it with
  // setFolders: the server refuses to answer /api without one, and a value
  // inherited from another test file in the same worker would point it at
  // folders this environment never created.
  process.env.VIDEOS_FOLDER_PATH = videosDir;
  // Pace the fake yt-dlp's progress lines: the download journey observes the
  // running state through the client's 1.5s queue poll, so a job must stay
  // visible for longer than one poll (3 lines x 600ms = 1.8s).
  process.env.FAKE_YTDLP_PROGRESS_DELAY_MS = '600';

  // Import after the environment is set (config.ts pins env values at load).
  const { createApp } = await loadAppModule();
  // A server module the test file imported first came back from the cache
  // with the values the process held then, and the app would reach a real
  // cluster, the real yt-dlp or a queue file outside the temp root. Nothing
  // listens or watches yet, so a refusal only has the fakes and the root to
  // release.
  const pinned = await findPinnedValues({
    ELASTICSEARCH_URL: esUrl,
    YTDLP_PATH: FAKE_YTDLP,
    QUEUE_STATE_FILE: queueStateFile,
  });
  if (pinned.length > 0) {
    await Promise.all([fakeEs.stop(), mockOpenai.stop()]);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    throw new Error(
      `A server module was imported before createDeepServerTestEnv set the environment, so the app holds ${pinned.join(', ')}. ` +
        'Import server modules inside a test or hook, after createDeepServerTestEnv resolves.',
    );
  }
  const app = createApp();
  // The real watcher runs for the whole environment, so a suite can create a
  // channel folder while the app is up and have it reach the folder list.
  // Behind the app, not in front of it: the snapshot it arms from is the one
  // the routes read.
  const libraryState = await loadLibraryStateModule();
  libraryState.startLibraryWatch();

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
    // A folder that is not there yet arrives whole, the way a mounted drive or
    // a folder moved in from elsewhere does: its files go into a staging
    // directory under the root, outside videos/, and one rename moves it into
    // place. The library watch on videos/ is a plain one, so the writes inside
    // a new folder raise no event of their own. A folder made empty and filled
    // afterwards could be read in between by the one reconcile its appearance
    // starts, and would then wait for the minute backstop.
    const isNew = !existsSync(folderPath);
    const target = isNew ? await fs.mkdtemp(path.join(root, '.seed-')) : folderPath;
    for (const [fileName, content] of Object.entries(files)) {
      await fs.writeFile(path.join(target, fileName), content);
    }
    if (isNew) {
      await fs.mkdir(path.dirname(folderPath), { recursive: true });
      await fs.rename(target, folderPath);
    }
    return folderPath;
  };
  const setFolders = (...names: string[]): void => {
    process.env.VIDEOS_FOLDER_PATH = names.map(folder).join(';');
    // The value changed, so the snapshot is rebuilt and the watcher re-armed
    // on the new roots before the test's next request. A folder created right
    // after this call is watched, not merely picked up by a later read.
    libraryState.getLibrarySnapshot();
  };
  const watchVideosDir = (): void => {
    process.env.VIDEOS_FOLDER_PATH = `${videosDir}/*`;
    // Same rebuild as setFolders, which is what arms the watcher on videos/
    // itself: the test can create a channel folder straight after this call.
    libraryState.getLibrarySnapshot();
  };
  const ytDlpCalls = (folderPath: string): Array<{ cwd: string; args: string[] }> => {
    try {
      return readFileSync(path.join(folderPath, YTDLP_ARGV_LOG_NAME), 'utf-8')
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as { cwd: string; args: string[] });
    } catch {
      return []; // the folder was not seeded with the log file
    }
  };

  const resetServerState = async (): Promise<void> => {
    const [folderRoutes, indexMaintenance] = await Promise.all([
      loadFolderRoutesModule(),
      loadIndexMaintenanceModule(),
    ]);
    // Each of these is one module-level copy for the whole process on purpose
    // (there is one cluster and one alias set), so all three outlive a test.
    folderRoutes.invalidateStatusCache();
    folderRoutes.invalidateSummaryCache();
    indexMaintenance.resetIndexMaintenanceState();
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
    watchVideosDir,
    ytDlpCalls,
    resetServerState,
    async dispose() {
      // Stop watching before the tree goes away: the handles would outlive the
      // test and keep firing at a directory that no longer exists.
      libraryState.stopLibraryWatch();
      if (httpServer) {
        await new Promise<void>((resolve, reject) => httpServer.close((error) => (error ? reject(error) : resolve())));
      }
      await Promise.all([fakeEs.stop(), mockOpenai.stop()]);
      await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    },
  };
}

/**
 * The files of one downloaded video, with the contents the fake yt-dlp
 * writes, under a `<date>_<title>` stem: the way downloads were named before
 * the id joined the name. Seeding the older stems keeps proving that they
 * work next to new downloads, which end in `_<id>`.
 */
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

/** The channel URL the deep environment's folders carry unless a seed says otherwise */
const DEEP_CHANNEL_URL = 'https://www.youtube.com/@deepchannel';

/** Folder config keys a seed may set; everything else keeps the shared default */
export interface FolderConfigSeed {
  /** Subtitle languages the folder asks yt-dlp to fetch */
  subLangs?: string[];
}

/** A valid folder config.json for the deep environment */
export function folderConfig(channelUrl = DEEP_CHANNEL_URL, category = 'tests', seed: FolderConfigSeed = {}): string {
  return JSON.stringify({ channelUrl, category, ...seed });
}

/**
 * One comment, shaped like the ones yt-dlp writes into an info.json. Only its
 * presence matters: the folder index counts a non-empty `comments` array as the
 * sidecar being there.
 */
const SEEDED_COMMENT = { id: 'Ugx-seeded-comment', author: 'Seeded viewer', text: 'Seeded comment.', like_count: 2 };

/**
 * A channel folder whose single video is on disk but incomplete: the media, the
 * info.json and the thumbnail are there, the Polish subtitles are not, and the
 * folder config asks for `pl` and `en`.
 *
 * That is the state a repair job exists to close, and the state a subtitle
 * fetch that ran into YouTube's rate limit leaves behind: `en` landed, `pl` did
 * not. Pair it with `FAKE_YTDLP_RATE_LIMIT_SUB_LANG=pl` on the environment to
 * have a repair reproduce that partial result.
 *
 * The info.json carries a comment on purpose. A folder that wants comments and
 * holds none reports a second, unrelated gap next to the subtitle, and a test
 * asserting the repair would then be asserting two things at once.
 */
export function incompleteVideoFiles(videoId: string, title: string): Record<string, string> {
  return {
    'config.json': folderConfig(DEEP_CHANNEL_URL, 'tests', { subLangs: ['pl', 'en'] }),
    'list.json': JSON.stringify([{ id: videoId, title, url: `https://www.youtube.com/watch?v=${videoId}` }]),
    ...videoFiles(videoId, title, { comments: [SEEDED_COMMENT] }),
  };
}
