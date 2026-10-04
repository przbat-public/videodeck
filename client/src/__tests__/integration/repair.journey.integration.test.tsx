import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { waitFor } from '@testing-library/react';
import type { DeepServerTestEnv } from '@videodeck/test-infra/deepServerTestEnv';
import { folderConfig, incompleteVideoFiles, YTDLP_ARGV_LOG_NAME } from '@videodeck/test-infra/deepServerTestEnv';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startBackend, stopBackend } from './test-env';

/**
 * Journey C: a video that is on disk but incomplete. It has its media, its
 * thumbnail and its English subtitles, and it never got the Polish ones —
 * which is what YouTube rate limiting (HTTP 429 on the automatic translation)
 * leaves behind on a real library, silently, because yt-dlp still exits 0.
 *
 * The journey walks the whole loop over the real backend: the state endpoint
 * names the gap, the repair endpoint queues a sidecar-only job for exactly that
 * video, the fake yt-dlp writes the missing file, and the state stops reporting
 * the gap. Reaching the API directly keeps it about the server contract; the
 * console rendering of the same state is covered by the component tests.
 */

let env: DeepServerTestEnv;

/** The video the seed created; a real 11-character YouTube id */
const VIDEO_ID = 'repairvid01';

beforeAll(async () => {
  env = await startBackend();
});

afterAll(async () => {
  await stopBackend();
});

afterEach(() => {
  delete process.env.FAKE_YTDLP_RATE_LIMIT_SUB_LANG;
});

interface VideoStateBody {
  known: boolean;
  state: {
    files: { subLangs: string[]; video: boolean } | null;
    missing: string[];
  };
}

/**
 * Wait until the folder's queue holds no live job. The API is the signal, not
 * a sleep: the same endpoint the console polls answers `queued`/`running`
 * while a job is alive and `done` once the fake yt-dlp has exited.
 */
async function waitForJobToFinish(folderPath: string): Promise<void> {
  await waitFor(
    async () => {
      const response = await fetch(`/api/folder/queue?folderPath=${encodeURIComponent(folderPath)}`);
      const body = (await response.json()) as { jobs: { status: string }[] };
      const live = body.jobs.filter((job) => job.status === 'queued' || job.status === 'running');
      expect(live).toEqual([]);
      expect(body.jobs.length).toBeGreaterThan(0);
    },
    { timeout: 30_000, interval: 200 },
  );
}

/** One video's state, as `GET /api/folder/video-state` answers it */
async function fetchVideoState(folderPath: string): Promise<VideoStateBody> {
  const response = await fetch(
    `/api/folder/video-state?folderPath=${encodeURIComponent(folderPath)}&videoId=${VIDEO_ID}`,
  );
  expect(response.status).toBe(200);
  return (await response.json()) as VideoStateBody;
}

describe('repair journey — a video that never got its Polish subtitles', () => {
  it('reports the gap, repairs it and stops reporting it', async () => {
    // The seed already writes a config.json asking for both languages, which
    // is what makes the missing Polish subtitle a gap rather than a choice.
    const folderPath = await env.seedFolder('channel-repair', {
      ...incompleteVideoFiles(VIDEO_ID, 'Fake incomplete video'),
      // Makes the process boundary record every yt-dlp call in this folder,
      // which is how the last step reads the repair's own arguments.
      [YTDLP_ARGV_LOG_NAME]: '',
    });
    env.setFolders('channel-repair');

    // 1. The state names the gap: English is there, Polish is missing.
    const before = await fetchVideoState(folderPath);
    expect(before.known).toBe(true);
    expect(before.state.files).toMatchObject({ video: true, subLangs: ['en'] });
    expect(before.state.missing).toEqual(['pl']);
    expect(existsSync(`${folderPath}/20260101_Fake incomplete video.pl.vtt`)).toBe(false);

    // 2. Repair the sidecars of that one video.
    const repair = await fetch('/api/folder/repair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ folderPath, method: 'sidecars', videos: [{ videoId: VIDEO_ID }] }),
    });
    expect(repair.status).toBe(202);
    const repairBody = (await repair.json()) as { jobs: { id: string; type: string }[]; skipped: unknown[] };
    expect(repairBody.skipped).toEqual([]);
    expect(repairBody.jobs.map((job) => job.type)).toEqual(['repair']);

    // 3. The job fetches the missing subtitle and leaves the media alone.
    await waitForJobToFinish(folderPath);
    const after = await fetchVideoState(folderPath);
    expect(after.state.files).toMatchObject({ video: true, subLangs: ['en', 'pl'] });
    // The gap is gone from the list, and the language list is the proof it is
    // gone for a reason. The one gap that may remain is `comments`: the fake
    // rewrites `.info.json` without a comment section, because it models
    // subtitles and metadata and not the comment API.
    expect(after.state.missing.filter((item) => item !== 'comments')).toEqual([]);
    expect(existsSync(`${folderPath}/20260101_Fake incomplete video.pl.vtt`)).toBe(true);

    // The repair wrote no media file of its own: the video that was there is
    // the video that is there, byte for byte.
    const media = await readFile(`${folderPath}/20260101_Fake incomplete video.mp4`, 'utf-8');
    expect(media).toBe('fake-mp4-bytes');

    // 4. The archive records the video the repair completed, even though the
    //    job itself passed no --download-archive. The post-job index refresh
    //    is what writes that line (`ensureArchiveHas`), which is why the
    //    archive and the disk do not drift apart after a repair.
    const archive = await readFile(`${folderPath}/archive.txt`, 'utf-8');
    expect(archive).toContain(`youtube ${VIDEO_ID}`);

    // 5. What the job was asked to do is visible at the process boundary: a
    //    repair passes --skip-download and never consults the archive.
    const repairCall = env.ytDlpCalls(folderPath).at(-1);
    expect(repairCall?.args).toContain('--skip-download');
    expect(repairCall?.args).toContain('--write-subs');
    expect(repairCall?.args.some((arg) => arg.includes('archive'))).toBe(false);
  });

  it('keeps the gap when the subtitle source rate limits the language', async () => {
    // The honest failure: YouTube answers 429 for the Polish translation,
    // yt-dlp exits 0 because repairs pass -i, and the video must still read as
    // incomplete afterwards. A silent success here is what leaves a channel
    // half-subtitled after a bulk run without anybody noticing.
    const folderPath = await env.seedFolder(
      'channel-ratelimited',
      incompleteVideoFiles(VIDEO_ID, 'Fake incomplete video'),
    );
    env.setFolders('channel-ratelimited');
    process.env.FAKE_YTDLP_RATE_LIMIT_SUB_LANG = 'pl';

    const repair = await fetch('/api/folder/repair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ folderPath, method: 'sidecars', videos: [{ videoId: VIDEO_ID }] }),
    });
    expect(repair.status).toBe(202);
    await waitForJobToFinish(folderPath);

    const after = await fetchVideoState(folderPath);
    expect(after.state.files).toMatchObject({ subLangs: ['en'] });
    // The Polish subtitle is the gap that matters, and it is still named.
    expect(after.state.missing).toContain('pl');
    expect(existsSync(`${folderPath}/20260101_Fake incomplete video.pl.vtt`)).toBe(false);
  });

  it('refuses to repair a video the folder does not hold', async () => {
    const folderPath = await env.seedFolder('channel-empty', {
      'config.json': folderConfig('https://www.youtube.com/@fake'),
    });
    env.setFolders('channel-empty');

    const repair = await fetch('/api/folder/repair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ folderPath, method: 'sidecars', videos: [{ videoId: VIDEO_ID }] }),
    });

    expect(repair.status).toBe(202);
    expect(await repair.json()).toMatchObject({ jobs: [], skipped: [{ videoId: VIDEO_ID, reason: 'not downloaded' }] });
  });
});
