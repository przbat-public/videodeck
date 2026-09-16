import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import type { DeepServerTestEnv } from '@videodeck/test-infra/deepServerTestEnv';
import { folderConfig } from '@videodeck/test-infra/deepServerTestEnv';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { findCardByTitle, queryCardByTitle, typeAndCommitPhrase } from './drivers/searchDrivers';
import { folderSection } from './drivers/statusDrivers';
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

/** The alias the server derives from a folder path (elasticsearchService) */
const folderAlias = (folderPath: string): string =>
  `videos_${createHash('sha256').update(folderPath).digest('hex').substring(0, 16)}`;

describe('download journey — pause, enqueue, resume, drain, search', () => {
  it('downloads the whole playlist through the queue and finds the videos in search without a reindex', async () => {
    const folderPath = env.folder('channel-integration');
    const page = await renderApp('/download');
    const section = await folderSection(folderPath);

    // 1. Pause the global queue first, so the enqueue below provably waits.
    await page.user.click(await screen.findByRole('button', { name: 'Pauza kolejki' }));
    await screen.findByRole('button', { name: 'Wznów kolejkę' });

    // 2. Pull the channel playlist (the fake yt-dlp answers --flat-playlist
    //    with two entries) and load the resulting list.json into the rows.
    await page.user.click(within(section).getByRole('button', { name: 'Pobierz playlistę' }));
    await within(section).findByText(/Plik list\.json już istnieje/);
    await page.user.click(within(section).getByRole('button', { name: 'Pobierz listę filmów' }));
    await within(section).findByText('Fake playlist video 1');

    // 3. Download everything while the queue is paused: both rows sit in
    //    the queued state and the header counts them. (The enqueue toast is
    //    incidental feedback — react-hot-toast renders unreliably in jsdom,
    //    so the journeys assert the rows and the header instead.)
    await page.user.click(within(section).getByRole('button', { name: 'Pobierz wszystkie' }));
    expect(await within(section).findAllByText('Pobieranie: w kolejce')).toHaveLength(2);
    await within(section).findByText(/kolejka: 0 w toku, 2 czeka/);

    // 4. The external world agrees: the persisted queue state records the
    //    pause and the two waiting jobs.
    await waitFor(async () => {
      const state = await readQueueState();
      expect(state.paused).toBe(true);
      expect(state.jobs).toHaveLength(2);
    });

    // 5. Resume: both jobs run through the fake yt-dlp and land on disk.
    await page.user.click(screen.getByRole('button', { name: 'Wznów kolejkę' }));
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
    expect(queryCardByTitle('Fake video bbbbbbbbbbb')).toBeInTheDocument();
    expect(queryCardByTitle('Głęboka integracja')).toBeInTheDocument();
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
    // The previous test left the queue running — pause it again. Wait for
    // the status page (and its queue bar) to leave the loading state.
    await page.user.click(await screen.findByRole('button', { name: 'Pauza kolejki' }));
    await screen.findByRole('button', { name: 'Wznów kolejkę' });

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
  });
});
