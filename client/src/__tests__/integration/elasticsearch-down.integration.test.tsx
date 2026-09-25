import { cleanup, screen, waitFor, within } from '@testing-library/react';
import type { DeepServerTestEnv } from '@videodeck/test-infra/deepServerTestEnv';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { findCardByTitle, queryCardByTitle, typeAndCommitPhrase } from './drivers/searchDrivers';
import { folderSection } from './drivers/statusDrivers';
import { refreshCacheAndWait, renderApp } from './render-app';
import { startBackend, stopBackend } from './test-env';

/**
 * What a user sees when the search backend is gone. The real client runs
 * against the real backend, and the fake Elasticsearch is stopped and started
 * again underneath it: the download console has to keep working from disk, the
 * banner has to name the broken dependency, search has to say the same thing
 * instead of "no results", and the retry has to clear the banner once the
 * cluster answers again.
 */

let env: DeepServerTestEnv;

const DOWN_MESSAGE = /Elasticsearch nie odpowiada/;
/** Elasticsearch calls retry for seconds before they fail, hence the budget */
const WAIT_MS = 20_000;

beforeAll(async () => {
  env = await startBackend();
});

afterAll(async () => {
  await stopBackend();
});

afterEach(() => {
  cleanup();
});

describe('Elasticsearch goes away and comes back', () => {
  it('keeps the console, banners the outage and recovers through the retry', async () => {
    await refreshCacheAndWait();
    const folderPath = env.folder('channel-integration');

    const page = await renderApp('/download');
    const section = await folderSection(folderPath);

    // Healthy first: the channel row is there and no banner is up
    await within(section).findByRole('button', { name: 'Pobierz playlistę' });
    expect(screen.queryByRole('status')).toBeNull();

    await env.fakeEs.stop();

    // Click through: the brand link leads to the list page, then a search
    await page.user.click(screen.getByRole('link', { name: 'Strona główna' }));
    const searchInput = await screen.findByLabelText('Fraza wyszukiwania');
    await page.user.type(searchInput, 'gleboka');
    await page.user.keyboard('{Enter}');

    // The failure names the dependency instead of pretending nothing matched
    expect(
      await screen.findByText(/Nie udało się wyszukać filmów: Elasticsearch nie odpowiada/, undefined, {
        timeout: WAIT_MS,
      }),
    ).toBeInTheDocument();
    expect(queryCardByTitle('Głęboka integracja')).not.toBeInTheDocument();

    // ... and the shell says it once for the whole app
    const banner = await screen.findByRole('status', undefined, { timeout: WAIT_MS });
    expect(banner).toHaveTextContent(DOWN_MESSAGE);

    // The index actions cannot work while the cluster is down
    await page.user.click(screen.getByRole('button', { name: 'Menu aplikacji' }));
    expect(await screen.findByRole('menuitem', { name: 'Odśwież indeks' }, { timeout: WAIT_MS })).toHaveAttribute(
      'data-disabled',
    );
    await page.user.keyboard('{Escape}');

    await env.fakeEs.restart();

    // The banner's retry is the user-visible way back, and the banner clears
    // itself as soon as the probe answers again
    await page.user.click(screen.getByRole('button', { name: 'Sprawdź ponownie' }));
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull(), { timeout: WAIT_MS });

    // Search works again without a page reload. A different phrase, because
    // re-submitting the failed one leaves the URL unchanged and the page would
    // keep its old error (the results area has a clear button, not a retry).
    //
    // The first search after a restart can still be refused in a millisecond:
    // the server remembers a fresh outage in a fail-fast window, every 503
    // re-arms it, and a read that lands inside answers "not reachable" while
    // the cluster is already back. The journey retries the phrase the way a
    // user does, inside the same budget; a cluster that never recovers still
    // fails here. Clearing the input first commits the empty phrase, so the
    // retry is a fresh search instead of a no-op on an unchanged URL.
    await waitFor(
      async () => {
        await page.user.clear(screen.getByLabelText('Fraza wyszukiwania'));
        await typeAndCommitPhrase(page.user, 'kosmos');
        // The matched phrase is wrapped in <mark>, so the card is matched by
        // its whole title rather than by a text node
        await findCardByTitle('Historia kosmosu', 5_000);
      },
      { timeout: WAIT_MS },
    );
  }, 90_000);

  it('serves the download console from disk while the cluster is down', async () => {
    await env.fakeEs.stop();
    try {
      await renderApp('/download');

      // Rows come from /api/status, which read the disk and reported the outage
      const row = await screen.findByText(env.folder('channel-integration'), undefined, { timeout: WAIT_MS });
      expect(row).toBeInTheDocument();
      await screen.findByText(DOWN_MESSAGE, undefined, { timeout: WAIT_MS });

      // The row no longer claims "no ES index": nothing could be read, and the
      // banner carries that state instead of a chip per channel
      expect(screen.queryByText('brak indeksu ES')).toBeNull();
    } finally {
      await env.fakeEs.restart();
    }
  }, 90_000);
});
