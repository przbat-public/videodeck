import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import type { DeepServerTestEnv } from '@videodeck/test-infra/deepServerTestEnv';
import { videoFiles } from '@videodeck/test-infra/deepServerTestEnv';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  categorySelect,
  channelSelect,
  findCardByTitle,
  findSearchInput,
  fromDateInput,
  pickOption,
  queryCardByTitle,
  sortSelect,
  toDateInput,
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

    // 4. The card opens the detail in place (no new tab).
    await page.user.click(screen.getByRole('link', { name: /Historia kosmosu/ }));
    await screen.findByRole('heading', { name: 'Historia kosmosu' });
    expect(await screen.findByText('Deep test description.', undefined, { timeout: 10_000 })).toBeInTheDocument();
    expect(await screen.findByText('Fake summary.', undefined, { timeout: 10_000 })).toBeInTheDocument();

    // 5. The top bar back link returns to the bare list.
    await page.user.click(screen.getByRole('link', { name: /Wróć do listy/ }));
    await findCardByTitle('Głęboka integracja');
    expect(await findSearchInput()).toHaveValue('');
  });

  it('narrows by upload date with the two date filters', async () => {
    await renderApp('/');

    // Empty query shows the whole library (four seeded videos).
    await findCardByTitle('Głęboka integracja');
    expect(queryCardByTitle('Drugi kanał wideo')).toBeInTheDocument();

    // From 2026-02-01: the two January videos drop out.
    fireEvent.change(fromDateInput(), { target: { value: '2026-02-01' } });
    await waitFor(() => expect(queryCardByTitle('Głęboka integracja')).not.toBeInTheDocument());
    expect(queryCardByTitle('Drugi kanał wideo')).not.toBeInTheDocument();
    expect(queryCardByTitle('Historia kosmosu')).toBeInTheDocument();
    expect(queryCardByTitle('Nowoczesne kino')).toBeInTheDocument();

    // To 2026-02-28: the March video drops out too.
    fireEvent.change(toDateInput(), { target: { value: '2026-02-28' } });
    await waitFor(() => expect(queryCardByTitle('Nowoczesne kino')).not.toBeInTheDocument());
    expect(queryCardByTitle('Historia kosmosu')).toBeInTheDocument();
  });

  it('scopes the search to one category folder', async () => {
    const page = await renderApp('/');
    await findCardByTitle('Drugi kanał wideo');

    await pickOption(page.user, categorySelect(), 'other');
    await waitFor(() => expect(queryCardByTitle('Głęboka integracja')).not.toBeInTheDocument());
    expect(queryCardByTitle('Drugi kanał wideo')).toBeInTheDocument();
    // A single-category search targets one physical index, never a comma list.
    expect(lastSearch().request?.path.includes(',')).toBe(false);

    await pickOption(page.user, categorySelect(), 'tests');
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
    await waitFor(() => expect(screen.getByText('Film pokazowy 105')).toBeInTheDocument());
    expect(lastSearch().body.from).toBe(100);
  });
});
