import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import type { DeepServerTestEnv } from '@videodeck/test-infra/deepServerTestEnv';
import { folderConfig, videoFiles } from '@videodeck/test-infra/deepServerTestEnv';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { findCardByTitle, queryCardByTitle, typeAndCommitPhrase } from './drivers/searchDrivers';
import { channelRow, folderSection } from './drivers/statusDrivers';
import type { RenderedApp } from './render-app';
import { renderApp } from './render-app';
import { startBackend, stopBackend } from './test-env';

/**
 * Journey B: the full download path, as a real user walks it — pause the
 * queue, pull the channel playlist, enqueue everything, resume, watch the
 * jobs land as files and then find the new videos through search without a
 * reindex. Every step also checks the state the app left in the fake
 * external world: the queue-state file, archive.txt, the folder's physical
 * index and the bulk requests sent to the fake Elasticsearch.
 */

let env: DeepServerTestEnv;

beforeAll(async () => {
  env = await startBackend();
});

afterAll(async () => {
  await stopBackend();
});

afterEach(() => {
  cleanup();
});

const queueStatePath = () => `${env.root}/.queue-state.json`;

const readQueueState = async (): Promise<{ paused?: boolean; jobs?: unknown[] }> => {
  const parsed = JSON.parse(await readFile(queueStatePath(), 'utf-8')) as unknown;
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('queue state file is not an object');
  }
  return parsed as { paused?: boolean; jobs?: unknown[] };
};

/**
 * Pause or resume the global queue through the API. A test uses the bar for
 * the action it asserts on, and this for the `finally` restore: the API does
 * not depend on the state the UI happens to be in when a test fails.
 */
async function setQueuePaused(paused: boolean): Promise<void> {
  const action = paused ? 'pause' : 'resume';
  const response = await fetch(`/api/folder/queue/${action}?paused=${paused ? 1 : 0}`, { method: 'POST' });
  if (!response.ok) {
    throw new Error(`queue ${action} failed with ${String(response.status)}`);
  }
}

/** Pause through the bar the reader uses, and wait until the bar shows it */
async function pauseQueueFromUi(page: RenderedApp): Promise<void> {
  await page.user.click(await screen.findByRole('button', { name: 'Pauza kolejki' }));
  await screen.findByRole('button', { name: 'Wznów kolejkę' });
}

/**
 * A channel folder whose playlist holds two videos with the first one already
 * on disk: the console row counts one missing video, and one job is enough to
 * drain it. Every test that needs this shape seeds it in its own body.
 */
async function seedConsoleRowFolder(name: string): Promise<string> {
  return env.seedFolder(name, {
    'config.json': folderConfig(`https://www.youtube.com/@${name}`),
    'list.json': JSON.stringify([
      { id: 'ddddddddddd', title: 'Juz pobrany', url: 'https://www.youtube.com/watch?v=ddddddddddd' },
      { id: 'eeeeeeeeeee', title: 'Do pobrania', url: 'https://www.youtube.com/watch?v=eeeeeeeeeee' },
    ]),
    // The first video is already on disk, so only the second may be queued
    ...videoFiles('ddddddddddd', 'Juz pobrany'),
  });
}

/** The alias the server derives from a folder path (elasticsearchService) */
const folderAlias = (folderPath: string): string =>
  `videos_${createHash('sha256').update(folderPath).digest('hex').substring(0, 16)}`;

describe('download journey — pause, enqueue, resume, drain, search', () => {
  it('downloads the whole playlist through the queue and finds the videos in search without a reindex', async () => {
    const folderPath = env.folder('channel-integration');
    const page = await renderApp('/download');
    const row = await channelRow(folderPath);
    const section = await folderSection(folderPath);
    // No list.json yet: the console row has nothing to count
    await within(row).findByText('0 filmów', undefined, { timeout: 15_000 });

    // 1. Pause the global queue first, so the enqueue below provably waits.
    await page.user.click(await screen.findByRole('button', { name: 'Pauza kolejki' }));
    await screen.findByRole('button', { name: 'Wznów kolejkę' });

    // 2. Pull the channel playlist (the fake yt-dlp answers --flat-playlist
    //    with two entries) and load the resulting list.json into the rows.
    //    The console row above learns the new count from the same click.
    await page.user.click(within(section).getByRole('button', { name: 'Pobierz playlistę' }));
    await within(section).findByText(/Plik list\.json już istnieje/);
    await within(row).findByText('2 filmów', undefined, { timeout: 15_000 });
    await page.user.click(within(section).getByRole('button', { name: 'Pobierz listę filmów' }));
    await within(section).findByText('Fake playlist video 1');

    // 3. Download everything while the queue is paused: both rows sit in
    //    the queued state and the header counts them. (The enqueue toast is
    //    incidental feedback — react-hot-toast renders unreliably in jsdom,
    //    so the journeys assert the rows and the header instead.) The row's
    //    "Kolejka" column follows without a page reload.
    await page.user.click(within(section).getByRole('button', { name: 'Pobierz wszystkie' }));
    expect(await within(section).findAllByText('Pobieranie: w kolejce')).toHaveLength(2);
    await within(section).findByText(/kolejka: 0 w toku, 2 czeka/);
    await within(row).findByText('2 czeka', undefined, { timeout: 15_000 });

    // 4. The external world agrees: the persisted queue state records the
    //    pause and the two waiting jobs.
    await waitFor(async () => {
      const state = await readQueueState();
      expect(state.paused).toBe(true);
      expect(state.jobs).toHaveLength(2);
    });

    // 5. Resume: both jobs run through the fake yt-dlp and land on disk.
    await page.user.click(screen.getByRole('button', { name: 'Wznów kolejkę' }));
    // The paced fake keeps a job alive for ~1.8s, longer than the client's
    // 1.5s queue poll: while it runs, the row shows the progress bar and
    // masks the raw `download …%` progress lines.
    await within(section).findByRole('progressbar', undefined, { timeout: 15_000 });
    expect(within(section).queryByText(/^download\s+\d/)).toBeNull();
    await waitFor(() => expect(within(section).queryAllByText('Pobrano')).toHaveLength(2), { timeout: 30_000 });
    expect(existsSync(`${folderPath}/20260101_Fake video aaaaaaaaaaa.mp4`)).toBe(true);
    expect(existsSync(`${folderPath}/20260101_Fake video bbbbbbbbbbb.info.json`)).toBe(true);
    const archive = await readFile(`${folderPath}/archive.txt`, 'utf-8');
    expect(archive).toContain('youtube aaaaaaaaaaa');
    expect(archive).toContain('youtube bbbbbbbbbbb');

    // 6. The drained queue clears the persisted jobs (the serialized writes
    //    guarantee the final snapshot cannot be overwritten by an older one).
    await waitFor(async () => {
      const state = await readQueueState();
      expect(state.paused).toBe(false);
      expect(state.jobs).toHaveLength(0);
    });

    // 7. The post-job hook indexed the downloads through the folder alias —
    //    no full reindex ran in this file, yet the alias exists and the
    //    incremental single-document writes carried the new titles.
    expect(env.fakeEs.aliasOf(folderAlias(folderPath))).toBeDefined();
    const docWrites = env.fakeEs.requestLog.filter((request) => request.path.includes('/_doc/'));
    expect(docWrites.some((request) => request.path.includes('/_doc/aaaaaaaaaaa'))).toBe(true);
    expect(docWrites.some((request) => request.path.includes('/_doc/bbbbbbbbbbb'))).toBe(true);
    expect(docWrites.some((request) => JSON.stringify(request.body ?? {}).includes('Fake video aaaaaaaaaaa'))).toBe(
      true,
    );

    // 8. Search finds the downloads through the alias — still without a full
    //    reindex. The first incremental sweep also picked up the seeded
    //    videos of the same folder (its folder index starts empty), but the
    //    second folder was never touched and stays out of search.
    page.unmount();
    const searchPage = await renderApp('/');
    await findCardByTitle('Fake video aaaaaaaaaaa');
    await findCardByTitle('Fake video bbbbbbbbbbb');
    await findCardByTitle('Głęboka integracja');
    expect(queryCardByTitle('Drugi kanał wideo')).not.toBeInTheDocument();

    await typeAndCommitPhrase(searchPage.user, 'aaaaaaaaaaa');
    await waitFor(() => expect(queryCardByTitle('Fake video bbbbbbbbbbb')).not.toBeInTheDocument());
    expect(queryCardByTitle('Fake video aaaaaaaaaaa')).toBeInTheDocument();
  });

  it('cancels a queued download from the row and leaves nothing on disk', async () => {
    const folderPath = env.folder('channel-cancel');
    await env.seedFolder('channel-cancel', {
      'config.json': folderConfig('https://www.youtube.com/@cancelchannel'),
      'list.json': JSON.stringify([
        { id: 'ccccccccccc', title: 'Film do anulowania', url: 'https://www.youtube.com/watch?v=ccccccccccc' },
      ]),
    });
    env.setFolders('channel-integration', 'channel-two', 'channel-cancel');

    const page = await renderApp('/download');
    // Pause the queue in this test's own body: the cancel below has to land
    // before the queue starts the job, whatever the previous test left behind.
    // The finally hands the next test a running queue.
    await pauseQueueFromUi(page);
    try {
      const section = await folderSection(folderPath);
      await page.user.click(within(section).getByRole('button', { name: 'Pobierz listę filmów' }));
      await within(section).findByText('Film do anulowania');

      await page.user.click(within(section).getByRole('button', { name: 'Pobierz' }));
      await within(section).findByText('Pobieranie: w kolejce');

      await page.user.click(within(section).getByRole('button', { name: 'Anuluj' }));
      await within(section).findByText('Anulowano');

      // The cancel happened before the fake yt-dlp ever ran: no files, and the
      // persisted state no longer holds the job.
      expect(existsSync(`${folderPath}/20260101_Fake video ccccccccccc.mp4`)).toBe(false);
      await waitFor(async () => {
        const state = await readQueueState();
        expect(state.paused).toBe(true);
        expect(state.jobs).toHaveLength(0);
      });
    } finally {
      await setQueuePaused(false);
    }
  });

  it('queues the missing videos of a channel from its console row', async () => {
    await seedConsoleRowFolder('channel-console-row');
    env.setFolders('channel-console-row');

    const page = await renderApp('/download');
    // Paused here on purpose: the new job has to wait while this test reads the
    // persisted state, and no other test may depend on that state.
    await pauseQueueFromUi(page);
    try {
      const row = await channelRow(env.folder('channel-console-row'));
      // Every queue action is in the row menu now
      await page.user.click(within(row).getByRole('button', { name: 'Więcej akcji' }));
      await page.user.click(await screen.findByRole('menuitem', { name: 'Pobierz wszystkie' }));

      await waitFor(async () => {
        const state = await readQueueState();
        expect(state.jobs).toHaveLength(1);
        expect(state.jobs?.[0]).toMatchObject({ videoId: 'eeeeeeeeeee' });
      });
    } finally {
      // Drop the job this test queued, then start the queue again: the next
      // test owns its own queue state and must not inherit a running download.
      await fetch(`/api/folder/queue?folderPath=${encodeURIComponent(env.folder('channel-console-row'))}`, {
        method: 'DELETE',
      });
      await setQueuePaused(false);
    }
  });

  it('moves the console counts of a channel as soon as its download lands', async () => {
    // A folder of this test's own with the same shape: one video on disk, one
    // missing. The paused queue holds its own job, so nothing is inherited.
    const folderPath = await seedConsoleRowFolder('channel-console-drain');
    env.setFolders('channel-console-drain');

    const page = await renderApp('/download');
    await pauseQueueFromUi(page);
    try {
      const row = await channelRow(folderPath);
      await within(row).findByText('1 niepobrany', undefined, { timeout: 15_000 });

      await page.user.click(within(row).getByRole('button', { name: 'Więcej akcji' }));
      await page.user.click(await screen.findByRole('menuitem', { name: 'Pobierz wszystkie' }));
      await within(row).findByText('1 czeka', undefined, { timeout: 15_000 });

      // Resume: the fake yt-dlp writes the files and the post-job hook refreshes
      // the folder index before the job reads as done.
      await page.user.click(screen.getByRole('button', { name: 'Wznów kolejkę' }));

      // The row learns about it from the queue poll alone: no reload, no action
      // taken on the page.
      await waitFor(() => expect(within(row).queryByText('1 niepobrany')).toBeNull(), { timeout: 20_000 });
      expect(within(row).getByText('2 filmów')).toBeInTheDocument();
      expect(within(row).queryByText('1 czeka')).toBeNull();
      expect(existsSync(`${folderPath}/20260101_Fake video eeeeeeeeeee.mp4`)).toBe(true);
    } finally {
      await setQueuePaused(false);
    }
  });
});
