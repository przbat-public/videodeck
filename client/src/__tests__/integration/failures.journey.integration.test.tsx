import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import type { DeepServerTestEnv } from '@videodeck/test-infra/deepServerTestEnv';
import { folderConfig, videoFiles } from '@videodeck/test-infra/deepServerTestEnv';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { toast } from '../../test/toastMock';
import { findCardByTitle, queryCardByTitle } from './drivers/searchDrivers';
import { folderSection } from './drivers/statusDrivers';
import type { RenderedApp } from './render-app';
import { refreshCacheAndWait, renderApp } from './render-app';
import { startBackend, stopBackend } from './test-env';

/**
 * Journey C: failure paths, as a real user hits them — permanent yt-dlp
 * errors translated per code in the queue rows, the OpenAI fallback chain
 * when the primary model is rate limited, a broken Elasticsearch failing the
 * search with a recovery, and a reindex that loses its bulk writes with a
 * retry. Every scenario also checks the state of the fake external world
 * (mock OpenAI request log, fake Elasticsearch faults and indices, files on
 * disk) so the assertions are about the system, not just the DOM.
 *
 * Toast feedback is asserted through the shared react-hot-toast mock: the
 * integration setup mounts the same mock as the unit suite, and its Toaster
 * renders nothing in jsdom, so toast text never reaches the DOM.
 */

let env: DeepServerTestEnv;

beforeAll(async () => {
  env = await startBackend();
  await refreshCacheAndWait();
});

afterAll(async () => {
  await stopBackend();
});

afterEach(() => {
  cleanup();
});

/** Opens the gear menu and picks one item by its visible label */
async function pickMenuItem(user: RenderedApp['user'], label: string): Promise<void> {
  // The top bar sits inside the lazy router tree, so the trigger appears
  // once the first chunk resolves; findByRole waits for it.
  await user.click(await screen.findByRole('button', { name: /Menu aplikacji|App menu/ }));
  await user.click(await screen.findByRole('menuitem', { name: label }));
}

describe('failure journeys — permanent errors, rate limits, broken dependencies', () => {
  it('turns members-only, private and removed entries into translated row errors', async () => {
    const folderPath = env.folder('channel-errors');
    await env.seedFolder('channel-errors', {
      'config.json': folderConfig('https://www.youtube.com/@errorchannel'),
      'list.json': JSON.stringify([
        {
          id: 'member99999',
          title: 'Tylko dla członków',
          url: 'https://www.youtube.com/watch?v=member99999',
        },
        {
          id: 'private9999',
          title: 'Prywatny film',
          url: 'https://www.youtube.com/watch?v=private9999',
        },
        {
          id: 'removed9999',
          title: 'Usunięty film',
          url: 'https://www.youtube.com/watch?v=removed9999',
        },
      ]),
    });
    env.setFolders('channel-integration', 'channel-two', 'channel-errors');

    const page = await renderApp('/download');
    const section = await folderSection(folderPath);
    await page.user.click(within(section).getByRole('button', { name: 'Pobierz listę filmów' }));
    await within(section).findByText('Tylko dla członków');

    await page.user.click(within(section).getByRole('button', { name: 'Pobierz wszystkie' }));

    // The fake yt-dlp fails each id immediately with the live error text;
    // the queue maps it to a machine-readable code and the row translates
    // it — the raw stderr stays visible in the job log below.
    await within(section).findByText('Ten film jest dostępny tylko dla członków kanału (members-only)', undefined, {
      timeout: 30_000,
    });
    await within(section).findByText('Ten film jest prywatny');
    await within(section).findByText('Ten film został usunięty lub jest niedostępny');
    expect(await within(section).findAllByText('Błąd')).toHaveLength(3);
    await within(section).findByText(/ERROR: \[youtube\] member99999/);
    // Errors keep the log, but never the running-state progress bar.
    expect(within(section).queryByRole('progressbar')).toBeNull();

    // Nothing landed on disk — the failures skipped the retry backoff. The
    // folder index build may create an empty archive.txt, but the failed ids
    // must never be recorded in it (a recorded id would skip future runs).
    expect(existsSync(`${folderPath}/20260101_Fake video member99999.mp4`)).toBe(false);
    const archive = existsSync(`${folderPath}/archive.txt`) ? await readFile(`${folderPath}/archive.txt`, 'utf-8') : '';
    expect(archive).not.toContain('member99999');
    expect(archive).not.toContain('private9999');
    expect(archive).not.toContain('removed9999');
  });

  it('walks the model fallback chain when the primary model is rate limited', async () => {
    env.mockOpenai.rateLimitModel('gpt-4o');
    try {
      await renderApp('/video/deepE2e0003');
      await screen.findByRole('heading', { name: 'Nowoczesne kino' });
      expect(await screen.findByText('Fake summary.', undefined, { timeout: 15_000 })).toBeInTheDocument();

      // The real summary pipeline retried with the next model in the chain;
      // the mock OpenAI saw both requests.
      expect(env.mockOpenai.requests.slice(-2).map((request) => request.model)).toEqual(['gpt-4o', 'gpt-4o-mini']);
    } finally {
      env.mockOpenai.clearRateLimits();
    }
  });

  it('shows the search failure when Elasticsearch breaks and recovers on reload', async () => {
    env.fakeEs.failRequestsMatching('/_search', 500);

    const page = await renderApp('/');
    // The user sees the failure toast, not a broken page or stale results.
    await waitFor(
      () =>
        expect(toast.error).toHaveBeenCalledWith(
          expect.stringContaining('Nie udało się wyszukać filmów'),
          expect.anything(),
        ),
      { timeout: 15_000 },
    );
    expect(queryCardByTitle('Głęboka integracja')).not.toBeInTheDocument();

    // The external world comes back; the reload item retries the search.
    env.fakeEs.clearFailures();
    await pickMenuItem(page.user, 'Odśwież wyniki');
    await findCardByTitle('Głęboka integracja');
    expect(queryCardByTitle('Drugi kanał wideo')).toBeInTheDocument();
  });

  it('reports folder errors when the reindex loses its bulk writes and succeeds on retry', async () => {
    const folderPath = env.folder('channel-retry');
    await env.seedFolder('channel-retry', videoFiles('retry0000001', 'Film po retry'));
    env.setFolders('channel-integration', 'channel-two', 'channel-retry');
    const indicesBefore = env.fakeEs.indexNames().length;

    env.fakeEs.failRequestsMatching('/_bulk', 500);
    const page = await renderApp('/');
    await pickMenuItem(page.user, 'Odśwież indeks');

    // Every folder fails its bulk write: the run reports three folder errors.
    await waitFor(
      () => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('3 błędy folderów'), expect.anything()),
      {
        timeout: 30_000,
      },
    );

    // The fake Elasticsearch heals; the same item retries the same run.
    env.fakeEs.clearFailures();
    await pickMenuItem(page.user, 'Odśwież indeks');
    await waitFor(
      () =>
        expect(toast.success).toHaveBeenCalledWith(
          expect.stringContaining('5 filmów zindeksowanych'),
          expect.anything(),
        ),
      {
        timeout: 30_000,
      },
    );

    // The retry really wrote new physical indices into the fake ES, and the
    // freshly scanned video is searchable.
    expect(env.fakeEs.indexNames().length).toBeGreaterThan(indicesBefore);
    await waitFor(() => expect(queryCardByTitle('Film po retry')).toBeInTheDocument(), { timeout: 15_000 });
    expect(existsSync(`${folderPath}/20260101_Film po retry.mp4`)).toBe(true);
  });
});
