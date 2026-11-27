import { existsSync, readdirSync, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { DeepServerTestEnv } from '@videodeck/test-infra/deepServerTestEnv';
import {
  createDeepServerTestEnv,
  folderConfig,
  incompleteVideoFiles,
  videoFiles,
} from '@videodeck/test-infra/deepServerTestEnv';

/**
 * Pins the incomplete-video seed the repair journey starts from: the media, the
 * info.json and the thumbnail are on disk, the Polish subtitles are not. The
 * console computes what a video is missing from exactly those files, so a seed
 * that quietly leaves a second gap would make the journey prove two things at
 * once. Also pins how seedFolder brings a folder into the library, which the
 * suites that watch a drive arrive rely on.
 *
 * The server modules load inside the test, after the environment is up: the
 * config module reads `process.env` when it is imported, and importing it
 * before `createDeepServerTestEnv` pinned those reads to the developer's own
 * values (see the ordering note in test-infra).
 */

let env: DeepServerTestEnv;

beforeAll(async () => {
  env = await createDeepServerTestEnv();
});

afterAll(async () => {
  await env.dispose();
});

/**
 * The state of one video, computed the way the folder state route does it:
 * the folder index for the disk, the config for what the folder asked for.
 */
async function readVideoState(folderPath: string, videoId: string) {
  const [{ readFolderConfig }, { loadIndex }, { videoDownloadState, wantedSidecars }] = await Promise.all([
    import('../services/folderConfig.js'),
    import('../services/folderIndex.js'),
    import('../services/videoState.js'),
  ]);
  const config = await readFolderConfig(folderPath);
  const wanted = wantedSidecars(config);
  const index = await loadIndex(folderPath);
  const entry = index.entries[videoId] ?? null;
  return { wanted, state: videoDownloadState({ entry, inArchive: false }, wanted) };
}

describe('the incomplete-video seed', () => {
  it('seeds a channel row whose only missing sidecar is the pl subtitle', async () => {
    const folderPath = await env.seedFolder(
      'channel-incomplete',
      incompleteVideoFiles('repair00001', 'Film do naprawy'),
    );
    const base = path.join(folderPath, '20260101_Film do naprawy');

    // What the download left behind, and what it did not
    expect(existsSync(`${base}.mp4`)).toBe(true);
    expect(existsSync(`${base}.info.json`)).toBe(true);
    expect(existsSync(`${base}.webp`)).toBe(true);
    expect(existsSync(`${base}.en.vtt`)).toBe(true);
    expect(existsSync(`${base}.pl.vtt`)).toBe(false);
    // The channel lists it, so the seed is a video row and not an orphan
    const list = JSON.parse(readFileSync(path.join(folderPath, 'list.json'), 'utf-8')) as Array<{ id: string }>;
    expect(list.map((row) => row.id)).toEqual(['repair00001']);

    // The folder asks for both languages, so the state can name the gap
    const { wanted, state } = await readVideoState(folderPath, 'repair00001');
    expect(wanted.subLangs).toEqual(['pl', 'en']);

    // And that gap is the only thing missing: the repair action exists for it
    expect(state.files?.subLangs).toEqual(['en']);
    expect(state.missing).toEqual(['pl']);
  });
});

describe('seedFolder', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('makes a folder that is not there yet appear with its files already inside', async () => {
    const files = { ...videoFiles('arrive00001', 'Arrives whole'), 'config.json': folderConfig() };
    const folderPath = env.folder('seed-arrives-whole');
    // Where each write of the seed landed, and whether the folder already
    // stood under videos/ by then. The library watch on videos/ is a plain
    // one: it hears the folder appear and the reconcile reads it once, so a
    // folder made empty and filled afterwards can be read in between and left
    // to the minute backstop.
    const writes: Array<{ underVideos: boolean; folderThere: boolean }> = [];
    const realWriteFile = fs.writeFile;
    vi.spyOn(fs, 'writeFile').mockImplementation(async (file, data, options) => {
      writes.push({
        underVideos: String(file).startsWith(`${env.videosDir}${path.sep}`),
        folderThere: existsSync(folderPath),
      });
      return realWriteFile(file, data, options);
    });

    await env.seedFolder('seed-arrives-whole', files);

    expect(writes).toEqual(Object.keys(files).map(() => ({ underVideos: false, folderThere: false })));
    expect(readdirSync(folderPath).sort()).toEqual(Object.keys(files).sort());
  });

  it('creates the directories above a new folder that are missing', async () => {
    const folderPath = await env.seedFolder(path.join('seed-drive', 'seed-channel'), { 'config.json': folderConfig() });

    expect(folderPath).toBe(path.join(env.videosDir, 'seed-drive', 'seed-channel'));
    expect(readdirSync(folderPath)).toEqual(['config.json']);
  });

  it('writes into a folder that is already there in place, next to what it holds', async () => {
    const folderPath = await env.seedFolder('seed-in-place', { 'config.json': folderConfig() });

    await env.seedFolder('seed-in-place', { 'list.json': '[]' });

    expect(readdirSync(folderPath).sort()).toEqual(['config.json', 'list.json']);
  });
});
