import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { waitFor } from '@testing-library/react';
import type { DeepServerTestEnv } from '@videodeck/test-infra/deepServerTestEnv';
import { incompleteVideoFiles, YTDLP_ARGV_LOG_NAME } from '@videodeck/test-infra/deepServerTestEnv';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startBackend, stopBackend } from './test-env';

/**
 * Journey D: refreshing the metadata of a video already in the archive. An
 * update ("Update", "Update stale") and a comment repair ("Refresh comments")
 * ask yt-dlp for what YouTube serves today, which can be less than what the
 * archive holds: comments turned off since the download, a refused comment
 * page, a subtitle YouTube throttles. Those runs write into a hidden staging
 * directory, and the server merges the result into the archive by rules that
 * only add: these journeys hold the server to them over the real backend and
 * the fake yt-dlp, which follows the live binary's file policy.
 */

let env: DeepServerTestEnv;

const VIDEO_ID = 'refreshvid1';
const STEM = '20260101_Fake incomplete video';
const ARCHIVED_COMMENT = 'Ugx-seeded-comment';
const FRESH_COMMENT = `Ugx-fake-${VIDEO_ID}`;

beforeAll(async () => {
  env = await startBackend();
});

afterAll(async () => {
  await stopBackend();
});

afterEach(() => {
  delete process.env.FAKE_YTDLP_COMMENTS;
  delete process.env.FAKE_YTDLP_DESCRIPTION;
  delete process.env.FAKE_YTDLP_FAIL_AFTER_WRITE;
  delete process.env.FAKE_YTDLP_RATE_LIMIT_SUB_LANG;
});

interface QueueBody {
  jobs: { status: string; error?: string }[];
}

/** The folder's queue once no job is queued or running; the API is the signal */
async function settledQueue(folderPath: string): Promise<QueueBody> {
  let settled: QueueBody = { jobs: [] };
  await waitFor(
    async () => {
      const response = await fetch(`/api/folder/queue?folderPath=${encodeURIComponent(folderPath)}`);
      const body = (await response.json()) as QueueBody;
      expect(body.jobs.length).toBeGreaterThan(0);
      expect(body.jobs.filter((job) => job.status === 'queued' || job.status === 'running')).toEqual([]);
      settled = body;
    },
    { timeout: 30_000, interval: 200 },
  );
  return settled;
}

async function seed(name: string): Promise<string> {
  const folderPath = await env.seedFolder(name, incompleteVideoFiles(VIDEO_ID, 'Fake incomplete video'));
  env.setFolders(name);
  return folderPath;
}

async function update(folderPath: string): Promise<QueueBody> {
  const response = await fetch('/api/folder/queue', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ folderPath, type: 'update', videos: [{ videoId: VIDEO_ID }] }),
  });
  expect(response.status).toBe(202);
  return settledQueue(folderPath);
}

async function refreshComments(folderPath: string): Promise<QueueBody> {
  const response = await fetch('/api/folder/repair', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ folderPath, method: 'comments', videos: [{ videoId: VIDEO_ID }] }),
  });
  expect(response.status).toBe(202);
  return settledQueue(folderPath);
}

async function commentIds(folderPath: string): Promise<string[]> {
  const info = JSON.parse(await readFile(`${folderPath}/${STEM}.info.json`, 'utf-8')) as {
    comments?: { id: string }[];
  };
  return (info.comments ?? []).map((comment) => comment.id);
}

/** What is left of the staging directory: nothing, once a job is over */
async function stagedLeftovers(folderPath: string): Promise<string[]> {
  const staging = `${folderPath}/.videodeck-staging`;
  return existsSync(staging) ? readdir(staging) : [];
}

describe('refresh journey — metadata of a video already in the archive', () => {
  it('keeps the archived comments when an update finds them turned off upstream', async () => {
    const folderPath = await seed('channel-comments-off');
    process.env.FAKE_YTDLP_COMMENTS = 'disabled';

    const queue = await update(folderPath);

    expect(queue.jobs.map((job) => job.status)).toEqual(['done']);
    expect(await commentIds(folderPath)).toEqual([ARCHIVED_COMMENT]);
    // The rest of the refresh landed: the title is today's
    const info = JSON.parse(await readFile(`${folderPath}/${STEM}.info.json`, 'utf-8')) as { title: string };
    expect(info.title).toBe(`Fake video ${VIDEO_ID}`);
    expect(await stagedLeftovers(folderPath)).toEqual([]);
  });

  it('keeps the archived description when the uploader blanked it', async () => {
    const folderPath = await seed('channel-description-blanked');
    const archivedFile = await readFile(`${folderPath}/${STEM}.description`, 'utf-8').catch(() => null);
    process.env.FAKE_YTDLP_DESCRIPTION = 'blank';

    await update(folderPath);

    const info = JSON.parse(await readFile(`${folderPath}/${STEM}.info.json`, 'utf-8')) as { description: string };
    expect(info.description).toBe('Deep test description.');
    // The seed has no .description file: a blank one is not written either
    expect(await readFile(`${folderPath}/${STEM}.description`, 'utf-8').catch(() => null)).toBe(archivedFile);
  });

  it('keeps a subtitle an update could not fetch again', async () => {
    const folderPath = await seed('channel-subtitle-throttled');
    const english = await readFile(`${folderPath}/${STEM}.en.vtt`, 'utf-8');
    process.env.FAKE_YTDLP_RATE_LIMIT_SUB_LANG = 'en';

    await update(folderPath);

    expect(await readFile(`${folderPath}/${STEM}.en.vtt`, 'utf-8')).toBe(english);
    expect(existsSync(`${folderPath}/${STEM}.pl.vtt`)).toBe(true);
  });

  it('leaves the archive byte for byte as it was when the run fails', async () => {
    const folderPath = await seed('channel-run-fails');
    const archived = await Promise.all(
      [`${STEM}.info.json`, `${STEM}.en.vtt`, `${STEM}.webp`].map((name) => readFile(`${folderPath}/${name}`, 'utf-8')),
    );
    // The fake writes every file into staging, then fails for good
    process.env.FAKE_YTDLP_FAIL_AFTER_WRITE = '1';

    const queue = await update(folderPath);

    expect(queue.jobs.map((job) => job.status)).toEqual(['error']);
    const after = await Promise.all(
      [`${STEM}.info.json`, `${STEM}.en.vtt`, `${STEM}.webp`].map((name) => readFile(`${folderPath}/${name}`, 'utf-8')),
    );
    expect(after).toEqual(archived);
    expect(existsSync(`${folderPath}/${STEM}.pl.vtt`)).toBe(false);
    expect(await stagedLeftovers(folderPath)).toEqual([]);
  });

  it('adds the fresh comments to the archived ones on "Refresh comments"', async () => {
    const folderPath = await seed('channel-refresh-comments');

    const queue = await refreshComments(folderPath);

    expect(queue.jobs.map((job) => job.status)).toEqual(['done']);
    expect(await commentIds(folderPath)).toEqual([FRESH_COMMENT, ARCHIVED_COMMENT]);
  });

  it('merges a comment section YouTube cut short, and does not retry it', async () => {
    const folderPath = await env.seedFolder('channel-comments-cut', {
      ...incompleteVideoFiles(VIDEO_ID, 'Fake incomplete video'),
      [YTDLP_ARGV_LOG_NAME]: '',
    });
    env.setFolders('channel-comments-cut');
    process.env.FAKE_YTDLP_COMMENTS = 'interrupted';

    const queue = await refreshComments(folderPath);

    expect(queue.jobs.map((job) => job.status)).toEqual(['done']);
    expect(await commentIds(folderPath)).toEqual([FRESH_COMMENT, ARCHIVED_COMMENT]);
    // One run: a retry would stop at the same refused page
    expect(env.ytDlpCalls(folderPath)).toHaveLength(1);
  });
});
