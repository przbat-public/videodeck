import { cleanup, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { refreshCacheAndWait, renderApp } from './render-app';
import { startBackend, stopBackend } from './test-env';

/**
 * Client integration (vita-tracker style): the real <App /> against the
 * real backend booted by the global setup. Only the backend's external
 * world is fake — everything between the UI and the fetch proxy is real.
 */

beforeAll(async () => {
  await startBackend();
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

    const searchPage = await renderApp('/videos');

    // Search without diacritics — the real analyzer folds the seeded title.
    const input = await screen.findByLabelText('Fraza wyszukiwania');
    await searchPage.user.type(input, 'gleboka');
    await searchPage.user.keyboard('{Enter}');
    await screen.findByText('Głęboka integracja');

    searchPage.unmount();

    // The detail page runs the real details endpoint (seeded info.json) and
    // the real summary pipeline against the mock OpenAI server.
    await renderApp('/video/deepE2e0001');
    await screen.findByText('Głęboka integracja');
    expect(await screen.findByText('Deep test description.', undefined, { timeout: 10_000 })).toBeInTheDocument();
    expect(await screen.findByText('Fake summary.', undefined, { timeout: 10_000 })).toBeInTheDocument();
    expect(screen.getByTestId('video-player').getAttribute('src')).toMatch(
      /\/api\/videos\/file\/20260101_G%C5%82%C4%99boka%20integracja\.mp4\?folder=/,
    );
  });

  it('downloads the playlist and runs a queue job through the fake yt-dlp', async () => {
    const page = await renderApp('/');

    // The seeded folder's section offers the playlist download; the fake
    // yt-dlp answers with two NDJSON entries.
    await screen.findByRole('button', { name: 'Pobierz playlistę' });
    await page.user.click(screen.getByRole('button', { name: 'Pobierz playlistę' }));
    await screen.findByText(/Plik list\.json już istnieje/);

    await page.user.click(screen.getByRole('button', { name: 'Pobierz listę filmów' }));
    await screen.findByText('Fake playlist video 1');

    // Enqueue the first entry: the real queue spawns the fake yt-dlp, which
    // writes the video files; the item flips to the downloaded state.
    const downloadButtons = screen.getAllByRole('button', { name: 'Pobierz' });
    expect(downloadButtons.length).toBeGreaterThan(0);
    if (downloadButtons[0]) {
      await page.user.click(downloadButtons[0]);
    }
    await screen.findByText('Pobrano', undefined, { timeout: 30_000 });
  });
});
