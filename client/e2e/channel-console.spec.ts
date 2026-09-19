import { expect, type Page, test } from '@playwright/test';
import { mockApi } from './helpers';

/**
 * The download console at library scale: twenty channels, which is where the
 * stacked folder sections it replaced measured 18 000 px tall. Everything here
 * needs more rows than a phone can show, so the mocks build a full library
 * instead of the one-folder default of `mockApi`.
 */

const CHANNELS = 20;

const folderPaths = Array.from(
  { length: CHANNELS },
  (_, index) => `/videos/kanal-${String(index + 1).padStart(2, '0')}`,
);

const consoleStatus = () => ({
  videosFolderPath: folderPaths,
  folderConfigs: Object.fromEntries(
    folderPaths.map((folderPath, index) => [
      folderPath,
      { channelUrl: `https://yt/@kanal${index + 1}`, category: 'fpv' },
    ]),
  ),
  downloadDefaults: { maxHeight: 2160, subLangs: ['en'], writeComments: true },
  // Five channels without an index and four without list.json: the chips and
  // the "needs attention" filter have something to bite on.
  indexedFolders: folderPaths.filter((_, index) => index >= 5),
  listExists: Object.fromEntries(folderPaths.map((folderPath, index) => [folderPath, index % 5 !== 0])),
  status: 'ok',
});

const consoleSummaries = () => ({
  summaries: Object.fromEntries(
    folderPaths.map((folderPath, index) => [
      folderPath,
      {
        videos: 40,
        downloaded: 40 - (index % 7) * 5,
        notDownloaded: (index % 7) * 5,
        stale: index % 3,
        newestUpdate: new Date(Date.UTC(2026, 8, 1 + (index % 18))).toISOString(),
      },
    ]),
  ),
});

/** A library of twenty channels, two of which have jobs in the queue */
/** The channel name every folder's videos carry in the fake index */
const channelName = (index: number): string => `Kanał ${String(index + 1).padStart(2, '0')}`;

async function consolePage(page: Page, viewport = { width: 1280, height: 900 }): Promise<void> {
  await page.setViewportSize(viewport);
  await mockApi(page, {
    status: consoleStatus(),
    summaries: consoleSummaries(),
    channels: {
      channels: folderPaths.map((_, index) => channelName(index)),
      folders: Object.fromEntries(folderPaths.map((folderPath, index) => [folderPath, channelName(index)])),
    },
    queue: {
      paused: false,
      jobs: [
        {
          id: 'job-running',
          folderPath: folderPaths[1],
          videoId: 'v-running',
          videoUrl: 'https://yt/v-running',
          type: 'download',
          status: 'running',
          progress: 42,
          log: [],
          logLineCount: 0,
          createdAt: '2026-01-01T10:00:00.000Z',
        },
        {
          id: 'job-failed',
          folderPath: folderPaths[2],
          videoId: 'v-failed',
          videoUrl: 'https://yt/v-failed',
          type: 'download',
          status: 'error',
          error: 'yt-dlp exited with code 1',
          log: [],
          logLineCount: 0,
          createdAt: '2026-01-01T10:00:00.000Z',
        },
      ],
    },
  });
  await page.goto('/download');
  await expect(page.locator('.channel-row')).toHaveCount(CHANNELS);
}

test.describe('channel console', () => {
  test('keeps twenty channels within a couple of screens', async ({ page }) => {
    await consolePage(page, { width: 1280, height: 900 });

    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    expect(height).toBeLessThan(900 * 2.2);

    // The page scrolls, the table does not: a nested scroll area is what made
    // the old stacked sections unusable.
    const nested = await page.evaluate(() => {
      const card = document.querySelector('.channel-table-card');
      if (!(card instanceof HTMLElement)) {
        return null;
      }
      return { scrollHeight: card.scrollHeight, clientHeight: card.clientHeight };
    });
    expect(nested).not.toBeNull();
    expect(nested?.scrollHeight ?? 0).toBeLessThanOrEqual((nested?.clientHeight ?? 0) + 1);
  });

  test('shows what the queue is doing with a channel', async ({ page }) => {
    await consolePage(page);

    const running = page.locator('.channel-row', { hasText: 'kanal-02' });
    await expect(running.getByText('1 w toku')).toBeVisible();

    const failed = page.locator('.channel-row', { hasText: 'kanal-03' });
    await expect(failed.getByText('1 błąd')).toBeVisible();
  });

  test('narrows the rows from the filter chips', async ({ page }) => {
    await consolePage(page);
    await expect(page.locator('.channel-row')).toHaveCount(CHANNELS);

    await page.getByRole('button', { name: /Wymaga uwagi/ }).click();
    await expect(page.getByRole('button', { name: /Wymaga uwagi/ })).toHaveAttribute('aria-pressed', 'true');

    // Some channels are fine on every count, so the chip has to leave them out
    await expect(page.locator('.channel-row')).not.toHaveCount(CHANNELS);
    await expect(page.locator('.channel-row').first()).toBeVisible();
  });

  test('the column headers stick below the queue bar', async ({ page }) => {
    await consolePage(page, { width: 1280, height: 600 });

    const header = page.locator('.channel-table thead th').first();
    const bar = page.locator('.channel-queue-bar');
    const before = await header.boundingBox();
    const barBefore = await bar.boundingBox();
    expect(before).not.toBeNull();
    expect(barBefore).not.toBeNull();

    await page.evaluate(() => window.scrollTo(0, 600));
    await expect.poll(async () => (await header.boundingBox())?.y ?? -1).toBeLessThan(300);

    const after = await header.boundingBox();
    const barAfter = await bar.boundingBox();
    const rowAfter = await page.locator('.channel-row').first().boundingBox();
    expect(after).not.toBeNull();
    expect(barAfter).not.toBeNull();
    expect(rowAfter).not.toBeNull();
    // The page scrolled, the header followed it to the top instead of leaving
    // the screen, and the rows slid underneath it.
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    expect(after?.y ?? 0).toBeLessThan(before?.y ?? 0);
    expect(after?.y ?? 0).toBeGreaterThanOrEqual(0);
    expect(rowAfter?.y ?? 0).toBeLessThan(after?.y ?? 0);
    expect(barAfter?.y ?? 0).toBeLessThanOrEqual((after?.y ?? 0) + 1);
    expect(Math.abs((after?.y ?? 0) - ((barAfter?.y ?? 0) + (barAfter?.height ?? 0)))).toBeLessThanOrEqual(2);
  });

  test('the console becomes a card list with 44px actions on a phone', async ({ page }) => {
    await consolePage(page, { width: 360, height: 800 });

    await expect(page.locator('.channel-table thead')).toBeHidden();
    await expect(page.locator('.channel-row').first()).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);

    // Touch contract: the expand toggle, the menu trigger and the entries
    // inside the menu all reach 44px
    const expand = await page.getByRole('button', { name: 'Pokaż filmy' }).first().boundingBox();
    const menu = await page.getByRole('button', { name: 'Więcej akcji' }).first().boundingBox();
    expect(expand?.height ?? 0).toBeGreaterThanOrEqual(43.5);
    expect(menu?.height ?? 0).toBeGreaterThanOrEqual(43.5);

    // kanal-01 has no list.json yet, so its menu offers the playlist; the
    // bulk entries are checked on the next row
    await page.locator('.channel-row', { hasText: 'kanal-02' }).getByRole('button', { name: 'Więcej akcji' }).click();
    const entry = await page.getByRole('menuitem', { name: 'Pobierz wszystkie' }).boundingBox();
    expect(entry?.height ?? 0).toBeGreaterThanOrEqual(43.5);
  });

  test('the row menu reaches the secondary actions', async ({ page }) => {
    await consolePage(page, { width: 1280, height: 900 });

    // kanal-02 has videos missing, a running job to cancel and a stale download.
    const row = page.locator('.channel-row', { hasText: 'kanal-02' });
    // Every queue action lives in the menu: the row carries no action button
    await expect(row.getByRole('button', { name: 'Pobierz wszystkie' })).toHaveCount(0);
    await row.getByRole('button', { name: 'Więcej akcji' }).click();

    await expect(page.getByRole('menuitem', { name: 'Aktualizuj stare' })).toBeEnabled();
    await expect(page.getByRole('menuitem', { name: 'Pobierz wszystkie' })).toBeEnabled();
    await expect(page.getByRole('menuitem', { name: 'Anuluj zadania kanału' })).toBeEnabled();
    // The search entry is a real link, so middle click and new tab work
    await expect(page.getByRole('menuitem', { name: 'Szukaj w tym kanale' })).toHaveAttribute(
      'href',
      `/?channel=${encodeURIComponent(channelName(1))}`,
    );
  });
});
