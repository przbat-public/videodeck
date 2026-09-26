import { cleanup, screen, waitFor } from '@testing-library/react';
import type { DeepServerTestEnv } from '@videodeck/test-infra/deepServerTestEnv';
import { videoFiles } from '@videodeck/test-infra/deepServerTestEnv';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import i18n from '../../i18n';
import { MAX_RETAINED_VIDEOS } from '../../reducers/videoSearchReducer';
import { clearListPositions } from '../../utils/listScrollMemory';
import {
  categorySelect,
  channelSelect,
  findCardByTitle,
  findSearchInput,
  pickOption,
  queryCardByTitle,
  sortSelect,
  typeAndCommitPhrase,
} from './drivers/searchDrivers';
import { refreshCacheAndWait, renderApp } from './render-app';
import { startBackend, stopBackend } from './test-env';

/**
 * Journey A: search from scratch, as a real user would do it. Every step
 * drives the real UI against the real backend and then checks what the
 * backend actually asked the fake Elasticsearch for, not just what the DOM
 * happens to show.
 */

let env: DeepServerTestEnv;

/**
 * The folder set `startBackend` seeds. The paging tests narrow it to their own
 * bulk folder, so every test restores it afterwards.
 */
const BASELINE_FOLDERS = ['channel-integration', 'channel-two'] as const;

beforeAll(async () => {
  env = await startBackend();
  await refreshCacheAndWait();
});

afterAll(async () => {
  await stopBackend();
});

afterEach(() => {
  cleanup();
  // The list remembers a reader's place per search URL: a test that leaves the
  // page would hand its position to the next one, and that next search would
  // restore pages nobody asked for. Every journey starts from a clean session.
  clearListPositions();
  // A narrowed folder set decides what the next test's first page holds, so a
  // shuffled order would otherwise change whose card is on it.
  env.setFolders(...BASELINE_FOLDERS);
});

interface SearchBody {
  from?: number;
  size?: number;
  query?: unknown;
  sort?: unknown;
}

/** The parsed body of the last search the app sent to the fake ES */
const lastSearch = () => {
  const requests = env.fakeEs.requestLog.filter((request) => request.path.includes('_search'));
  const last = requests.at(-1);
  expect(last, 'the app never searched the fake Elasticsearch').toBeDefined();
  return { request: last, body: (last?.body ?? {}) as SearchBody };
};

describe('search journey — real user, real backend, fake Elasticsearch', () => {
  it('types, sorts, filters by channel, opens a result and returns with the state intact', async () => {
    const page = await renderApp('/');

    // 1. Phrase with a debounce commit (Enter), no diacritics on purpose.
    //    Wait for the initial results first: typing over a loading list
    //    races with the first search.
    await findCardByTitle('Głęboka integracja');
    await typeAndCommitPhrase(page.user, 'kosmos');
    await waitFor(() => expect(queryCardByTitle('Głęboka integracja')).not.toBeInTheDocument());
    expect(await findCardByTitle('Historia kosmosu')).toBeInTheDocument();
    expect(JSON.stringify(lastSearch().body)).toContain('kosmos');

    // 2. Sort by views: the backend's ES body must carry the viewCount sort.
    await pickOption(page.user, sortSelect(), 'Najwięcej wyświetleń');
    await waitFor(() => expect(JSON.stringify(lastSearch().body)).toContain('viewCount'));

    // 3. Channel filter commits after the same pause as the phrase.
    await pickOption(page.user, await channelSelect(), 'Deep test channel');
    await waitFor(() => expect(JSON.stringify(lastSearch().body)).toContain('Deep test channel'));

    // 4. The card opens the detail in place (no new tab). The wait is on the
    //    route signal the app emits, never on the detail heading: the card
    //    renders the same title as an <h3> on the list, so a heading query is
    //    already satisfied before the click and cannot tell the detail page
    //    from the list. The URL, the detail-only back link and the vanished
    //    search form can only all hold on the detail page.
    await page.user.click(screen.getByRole('link', { name: /Historia kosmosu/ }));
    await waitFor(
      () => {
        expect(page.router.state.location.pathname).toBe('/video/deepE2e0002');
        expect(screen.getByRole('link', { name: /Wróć do listy/ })).toBeInTheDocument();
        expect(screen.queryByLabelText('Fraza wyszukiwania')).toBeNull();
      },
      { timeout: 15_000 },
    );
    expect(await screen.findByText('Deep test description.', undefined, { timeout: 10_000 })).toBeInTheDocument();
    expect(await screen.findByText('Fake summary.', undefined, { timeout: 10_000 })).toBeInTheDocument();

    // 5. The top bar back link returns to the bare list.
    await page.user.click(screen.getByRole('link', { name: /Wróć do listy/ }));
    await findCardByTitle('Głęboka integracja');
    expect(await findSearchInput()).toHaveValue('');
  });

  it('scopes the search to one category folder', async () => {
    const page = await renderApp('/');
    await findCardByTitle('Drugi kanał wideo');

    await pickOption(page.user, await categorySelect(), 'other');
    await waitFor(() => expect(queryCardByTitle('Głęboka integracja')).not.toBeInTheDocument());
    expect(queryCardByTitle('Drugi kanał wideo')).toBeInTheDocument();
    // A single-category search targets one physical index, never a comma list.
    expect(lastSearch().request?.path.includes(',')).toBe(false);

    await pickOption(page.user, await categorySelect(), 'tests');
    await waitFor(() => expect(queryCardByTitle('Drugi kanał wideo')).not.toBeInTheDocument());
    expect(queryCardByTitle('Głęboka integracja')).toBeInTheDocument();
  });

  it('pages through a large library with Show more', async () => {
    // A second folder with 105 generated videos: the page size is 100, so
    // the first empty-query search must stop one page short.
    const bulk: Record<string, string> = {};
    for (let i = 1; i <= 105; i += 1) {
      const id = `bulk${String(i).padStart(4, '0')}`;
      Object.assign(bulk, videoFiles(id, `Film pokazowy ${String(i).padStart(3, '0')}`));
    }
    await env.seedFolder('channel-bulk', bulk);
    env.setFolders('channel-integration', 'channel-two', 'channel-bulk');
    const indicesBefore = env.fakeEs.indexNames().length;
    await refreshCacheAndWait();
    // The unchanged folders keep their indices (the cache skips them); the
    // new folder gets a fresh physical index with an alias switch.
    expect(env.fakeEs.indexNames().length).toBeGreaterThanOrEqual(indicesBefore + 1);

    const page = await renderApp('/');
    // The Show more button only renders when a next page exists, so it also
    // proves the first search landed.
    await screen.findByRole('button', { name: 'Pokaż więcej' });
    expect(lastSearch().body.from ?? 0).toBe(0);

    await page.user.click(screen.getByRole('button', { name: 'Pokaż więcej' }));
    // Page two appends a hundred cards. Waiting for the request first keeps the
    // assertion below off the default 1 s waitFor budget, which rendering that
    // page can outrun on a loaded machine.
    await waitFor(() => expect(lastSearch().body.from).toBe(100), { timeout: 15_000 });
    await waitFor(() => expect(screen.getByText('Film pokazowy 105')).toBeInTheDocument(), { timeout: 15_000 });
  });

  it('keeps a long scroll paging the server while the window of results stays bounded', async () => {
    // 305 videos: four pages of the server's 100-row pages. The results window
    // holds the two pages loaded last, so the third page starts releasing rows.
    // Every video gets its own upload date and the newest date wins, so the row
    // order is exact: 305 is the first row, 001 the last.
    const bulk: Record<string, string> = {};
    for (let index = 1; index <= 305; index += 1) {
      const id = `long${String(index).padStart(4, '0')}`;
      const title = `Long video ${String(index).padStart(3, '0')}`;
      Object.assign(bulk, videoFiles(id, title, { upload_date: uploadDate(index) }));
    }
    await env.seedFolder('channel-long', bulk);
    // Only this folder is searched, so the counts below are exact.
    env.setFolders('channel-long');
    await refreshCacheAndWait();

    const page = await renderApp('/');
    await screen.findByText('Long video 305');

    // A card is a link to its video; the page shell carries no other /video/ links.
    const cards = () => screen.getAllByRole('link').filter((link) => link.getAttribute('href')?.startsWith('/video/'));
    const backToTop = () => screen.queryByRole('button', { name: i18n.t('search.backToTop') });

    expect(cards()).toHaveLength(100);
    expect(backToTop()).toBeNull();

    /**
     * Ask for the next page and wait until the last row it carries is on
     * screen: the card count alone cannot tell a fresh page from the one
     * already there.
     */
    const loadPage = async (from: number, lastRow: string): Promise<void> => {
      await page.user.click(screen.getByRole('button', { name: i18n.t('search.loadMore') }));
      await waitFor(() => expect(lastSearch().body.from).toBe(from), { timeout: 15_000 });
      await waitFor(() => expect(screen.getByText(lastRow)).toBeInTheDocument(), { timeout: 15_000 });
    };

    // Page two fits: 200 rows loaded, 200 rows kept.
    await loadPage(100, 'Long video 106');
    expect(cards()).toHaveLength(MAX_RETAINED_VIDEOS);
    expect(screen.getByText('Long video 305')).toBeInTheDocument();
    expect(backToTop()).toBeNull();

    // Page three fills the window: 300 loaded, 200 kept, the first page gone.
    await loadPage(200, 'Long video 006');
    expect(cards()).toHaveLength(MAX_RETAINED_VIDEOS);
    expect(screen.queryByText('Long video 305')).toBeNull();
    expect(screen.getByText(i18n.t('search.trimmedNotice', { count: 100 }))).toBeInTheDocument();

    // Page four, the short tail page: 305 loaded, still 200 kept.
    await loadPage(300, 'Long video 001');
    expect(cards()).toHaveLength(MAX_RETAINED_VIDEOS);
    expect(screen.getByText(i18n.t('search.trimmedNotice', { count: 105 }))).toBeInTheDocument();

    // The way back: a fresh search from the first row, so the first page is on
    // screen instead of the tail of the scroll.
    await page.user.click(screen.getByRole('button', { name: i18n.t('search.backToTop') }));

    await waitFor(() => expect(lastSearch().body.from).toBe(0));
    await waitFor(() => expect(cards()).toHaveLength(100));
    expect(screen.getByText('Long video 305')).toBeInTheDocument();
    expect(backToTop()).toBeNull();
    // A keyboard user lands at the top of the results, not on a button that
    // just disappeared.
    expect(screen.getByRole('main')).toHaveFocus();
  });
});

/**
 * Upload date for the video at `index`, one day apart, so the default
 * date-desc sort of the seeded folder is fully deterministic.
 */
function uploadDate(index: number): string {
  const date = new Date(Date.UTC(2025, 0, index));
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${date.getUTCFullYear()}${month}${day}`;
}
