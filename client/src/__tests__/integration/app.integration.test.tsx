import { cleanup, screen, within } from '@testing-library/react';
import type { DeepServerTestEnv } from '@videodeck/test-infra/deepServerTestEnv';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { channelRow, folderSection } from './drivers/statusDrivers';
import { refreshCacheAndWait, renderApp } from './render-app';
import { startBackend, stopBackend } from './test-env';

/**
 * Client integration (vita-tracker style): the real <App /> against the
 * real backend booted by the global setup. Only the backend's external
 * world is fake — everything between the UI and the fetch proxy is real.
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

describe('client integration — real backend', () => {
  it('reindexes, finds the seeded video and serves details with a mock-LLM summary', async () => {
    await refreshCacheAndWait();

    const searchPage = await renderApp('/');

    // Search without diacritics — the real analyzer folds the seeded title.
    const input = await screen.findByLabelText('Fraza wyszukiwania');
    await searchPage.user.type(input, 'gleboka');
    await searchPage.user.keyboard('{Enter}');
    await screen.findByText('Głęboka integracja');

    searchPage.unmount();

    // The detail page runs the real details endpoint (seeded info.json) and
    // the real summary pipeline against the mock OpenAI server.
    await renderApp('/video/deepE2e0001');
    await screen.findByRole('heading', { name: 'Głęboka integracja' });
    expect(await screen.findByText('Deep test description.', undefined, { timeout: 10_000 })).toBeInTheDocument();
    expect(await screen.findByText('Fake summary.', undefined, { timeout: 10_000 })).toBeInTheDocument();
    expect(screen.getByTestId('video-player').getAttribute('src')).toMatch(
      /\/api\/videos\/file\/20260101_G%C5%82%C4%99boka%20integracja\.mp4\?folder=/,
    );
  });

  it('searches inside one channel from the console row, using the channel name', async () => {
    // The console link has to carry the name the search filters by
    // (channelName), not the folder path: the index is seeded with two
    // channels whose names differ from their folders.
    await refreshCacheAndWait();

    const page = await renderApp('/download');
    const row = await channelRow(env.folder('channel-two'));

    await page.user.click(within(row).getByRole('button', { name: 'Więcej akcji' }));
    const link = await screen.findByRole('menuitem', { name: 'Szukaj w tym kanale' });
    expect(link).toHaveAttribute('href', '/?channel=Drugi%20kana%C5%82');

    await page.user.click(link);

    // The list page arrives filtered to that channel: only its video shows,
    // and the channel select names the channel rather than an unknown value
    expect(await screen.findByText('Drugi kanał wideo')).toBeInTheDocument();
    expect(await screen.findByRole('combobox', { name: 'Kanał' })).toHaveTextContent('Drugi kanał');
    expect(page.router.state.location.search).toBe('?channel=Drugi%20kana%C5%82');
    expect(screen.queryByText('Głęboka integracja')).toBeNull();
  });

  it('downloads the playlist and runs a queue job through the fake yt-dlp', async () => {
    const page = await renderApp('/download');

    // The console keeps every folder behind its channel row, so the seeded
    // folder is expanded first; its section then offers the playlist download
    // and the fake yt-dlp answers with two NDJSON entries.
    const section = await folderSection(env.folder('channel-integration'));
    await page.user.click(within(section).getByRole('button', { name: 'Pobierz playlistę' }));
    await within(section).findByText(/Plik list\.json już istnieje/);

    await page.user.click(within(section).getByRole('button', { name: 'Pobierz listę filmów' }));
    await within(section).findByText('Fake playlist video 1');

    // Enqueue the first entry: the real queue spawns the fake yt-dlp, which
    // writes the video files; the item flips to the downloaded state.
    const downloadButtons = within(section).getAllByRole('button', { name: 'Pobierz' });
    expect(downloadButtons.length).toBeGreaterThan(0);
    if (downloadButtons[0]) {
      await page.user.click(downloadButtons[0]);
    }
    await within(section).findByText('Pobrano', undefined, { timeout: 30_000 });
  });
});
