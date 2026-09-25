import { act, cleanup, screen, waitFor } from '@testing-library/react';
import type { DeepServerTestEnv } from '@videodeck/test-infra/deepServerTestEnv';
import { videoFiles } from '@videodeck/test-infra/deepServerTestEnv';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearListPositions } from '../../utils/listScrollMemory';
import { findCardByTitle } from './drivers/searchDrivers';
import { refreshCacheAndWait, renderApp } from './render-app';
import { startBackend, stopBackend } from './test-env';

/**
 * Journey C: reading a long result list, opening a result and coming back.
 * The list keeps its state in the URL but not the reader's place in it, so
 * before this journey existed, going back re-ran page one, left the document
 * short and dropped the reader at the top. jsdom has no layout, so the
 * assertions are on what the app really controls: the scroll target it asks
 * for, the pages it re-fetches and the element it focuses.
 *
 * Every step waits on a signal the app itself produces, with the journey
 * suite's budget. The detail page is lazy and its data arrives over the
 * network; neither is what this journey is about, so nothing here waits for
 * the details request to land.
 */

let env: DeepServerTestEnv;

/** The scroll call the app made to put the reader back */
const scrollTo = vi.fn();

/** jsdom never lays anything out, so the reader's offset is pinned by hand */
function setScrollY(value: number): void {
  Object.defineProperty(window, 'scrollY', { configurable: true, value });
}

beforeAll(async () => {
  env = await startBackend();
  // A third folder with 105 generated videos: the page size is 100, so the
  // empty-query search returns a first page with more behind it.
  const bulk: Record<string, string> = {};
  for (let i = 1; i <= 105; i += 1) {
    const id = `bulk${String(i).padStart(4, '0')}`;
    Object.assign(bulk, videoFiles(id, `Film pokazowy ${String(i).padStart(3, '0')}`));
  }
  await env.seedFolder('channel-bulk', bulk);
  env.setFolders('channel-integration', 'channel-two', 'channel-bulk');
  await refreshCacheAndWait();
});

afterAll(async () => {
  await stopBackend();
});

beforeEach(() => {
  scrollTo.mockClear();
  vi.stubGlobal('scrollTo', scrollTo);
  setScrollY(0);
});

afterEach(() => {
  cleanup();
  clearListPositions();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, 'scrollY');
});

describe('scroll restoration journey — a real list, a real video, a real Back', () => {
  it('comes back to the place in the list the reader left', async () => {
    const page = await renderApp('/');

    // Page one is in: the button only renders while the server has more
    await screen.findByRole('button', { name: 'Pokaż więcej' }, { timeout: 15_000 });
    await page.user.click(screen.getByRole('button', { name: 'Pokaż więcej' }));
    // The second page carries the last videos of the library
    expect(await screen.findByText('Film pokazowy 105', undefined, { timeout: 15_000 })).toBeInTheDocument();

    // The reader scrolls deep into page two and opens a video. The video
    // comes from the seeded fixture folder, the only one with a list.json
    // the detail page can read.
    setScrollY(1500);
    await page.user.click(screen.getByRole('link', { name: /Historia kosmosu/ }));

    // The route change is the signal this journey needs, and the app reports
    // it itself: the URL is the video's, the top bar only carries the back
    // link on a detail page, and the results list (its search form and its
    // cards) is gone. Waiting on the detail page's own heading instead costs
    // the lazy chunk plus the details request, and a slow runner spent more
    // than the default async budget on those two and reported a list that had
    // simply not navigated yet.
    await waitFor(
      () => {
        expect(page.router.state.location.pathname).toBe('/video/deepE2e0002');
        expect(screen.getByRole('link', { name: /Wróć do listy/ })).toBeInTheDocument();
        expect(screen.queryByLabelText('Fraza wyszukiwania')).toBeNull();
      },
      { timeout: 15_000 },
    );

    // Back, the way a reader goes back: browser history, URL intact
    await act(async () => {
      await page.router.navigate(-1);
    });

    // Both pages come back, so the reader is not dropped into a short
    // document, and the offset they left is asked for
    expect(await findCardByTitle('Głęboka integracja')).toBeInTheDocument();
    expect(await findCardByTitle('Film pokazowy 105')).toBeInTheDocument();
    await waitFor(
      () => {
        expect(scrollTo).toHaveBeenCalledWith(0, 1500);
        expect(page.router.state.location.pathname).toBe('/');
      },
      { timeout: 15_000 },
    );

    // The route change still hands the keyboard a landmark to land on
    await waitFor(() => expect(screen.getByRole('main')).toHaveFocus(), { timeout: 15_000 });
  });
});
