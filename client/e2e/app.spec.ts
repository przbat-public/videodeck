import { expect, test } from '@playwright/test';
import { json, mockApi, video } from './helpers';

test.describe('search page', () => {
  test('the URL drives the form and the results', async ({ page }) => {
    await mockApi(page, {
      search: (params) => {
        expect(params.get('q')).toBe('motor');
        expect(params.get('sort')).toBe('views-desc');
        expect(params.get('category')).toBe('fpv');
        expect(params.get('channel')).toBe('Kanał E2E');
        expect(params.get('dateFrom')).toBe('20240105');
        expect(params.get('dateTo')).toBe('20251231');
        expect(params.get('offset')).toBe('0');
        return { videos: [video('v1', 'Silnik krokowy')], totalCount: 1 };
      },
    });

    await page.goto(
      '/?q=motor&sort=views-desc&category=fpv&channel=Kana%C5%82+E2E&dateFrom=2024-01-05&dateTo=2025-12-31',
    );

    await expect(page.getByPlaceholder('Szukaj filmów po opisie...')).toHaveValue('motor');
    await expect(page.getByRole('combobox', { name: 'Sort' })).toContainText('Najwięcej wyświetleń');
    await expect(page.getByRole('combobox', { name: 'Kategoria' })).toContainText('fpv');
    await expect(page.getByRole('combobox', { name: 'Kanał' })).toContainText('Kanał E2E');
    await expect(page.getByLabel('Od daty')).toHaveValue('2024-01-05');
    await expect(page.getByLabel('Do daty')).toHaveValue('2025-12-31');
    await expect(page.getByText('Silnik krokowy')).toBeVisible();
    // the URL is not rewritten for valid parameters
    expect(new URL(page.url()).search).toContain('q=motor');
  });

  test('the language switcher flips the UI to English and back', async ({ page }) => {
    await mockApi(page);

    await page.goto('/');
    await expect(page.getByPlaceholder('Szukaj filmów po opisie...')).toBeVisible();

    await page.getByRole('button', { name: 'Menu aplikacji' }).click();
    await page.getByRole('menuitem', { name: 'English' }).click();
    await expect(page.getByPlaceholder('Search videos by description...')).toBeVisible();

    // The menu now speaks English, including the list-page index actions.
    await page.getByRole('button', { name: 'App menu' }).click();
    await expect(page.getByRole('menuitem', { name: 'Refresh index' })).toBeVisible();
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'App menu' }).click();
    await page.getByRole('menuitem', { name: 'Polski' }).click();
    await expect(page.getByPlaceholder('Szukaj filmów po opisie...')).toBeVisible();
  });

  test('the theme switcher sets data-theme and survives a reload', async ({ page }) => {
    await mockApi(page);

    await page.goto('/');

    await page.getByRole('button', { name: 'Menu aplikacji' }).click();
    await page.getByRole('menuitem', { name: 'Ciemny' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });

  test('the sort select opens the list and changes the sort', async ({ page }) => {
    const sorts: (string | null)[] = [];
    await mockApi(page, {
      search: (params) => {
        sorts.push(params.get('sort'));
        return { videos: [], totalCount: 0 };
      },
    });

    await page.goto('/');
    await page.getByRole('combobox', { name: 'Sort' }).click();
    await page.getByRole('option', { name: 'Najnowsze' }).click();

    await expect(page.getByRole('combobox', { name: 'Sort' })).toContainText('Najnowsze');
    await expect.poll(() => sorts).toContain('date-desc');
  });

  test('"Show more" appends the next page', async ({ page }) => {
    await mockApi(page, {
      search: (params) =>
        params.get('offset') === '1'
          ? { videos: [video('v2', 'Drugi film')], totalCount: 2 }
          : { videos: [video('v1', 'Pierwszy film')], totalCount: 2 },
    });

    await page.goto('/');
    await expect(page.getByText('Pierwszy film')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Pokaż więcej' })).toBeVisible();

    await page.getByRole('button', { name: 'Pokaż więcej' }).click();

    await expect(page.getByText('Drugi film')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Pokaż więcej' })).toBeHidden();
  });

  test('an empty phrase shows the no-results message', async ({ page }) => {
    await mockApi(page, { search: () => ({ videos: [], totalCount: 0 }) });

    await page.goto('/');

    await expect(page.getByText('Brak filmów. Spróbuj innego zapytania.')).toBeVisible();
  });

  test('Enter commits the typed phrase from the keyboard', async ({ page }) => {
    const queries: (string | null)[] = [];
    await mockApi(page, {
      search: (params) => {
        queries.push(params.get('q'));
        return { videos: [video('v1', 'Film z Entera')], totalCount: 1 };
      },
    });

    await page.goto('/');

    const input = page.getByLabel('Fraza wyszukiwania');
    await input.fill('dron');
    await input.press('Enter');

    await expect(page.getByText('Film z Entera')).toBeVisible();
    // The initial (empty-phrase) search resolves first and also matches the
    // mock — wait for the Enter-committed search to actually hit the API
    await expect.poll(() => queries).toContain('dron');
  });

  test('a search failure shows the error toast', async ({ page }) => {
    await mockApi(page);
    // Registered after mockApi, so this route wins for the search endpoint
    await page.route('**/api/videos/search**', (route) => route.fulfill(json({ error: 'Elasticsearch is down' }, 500)));

    await page.goto('/');

    await expect(page.getByText(/Nie udało się wyszukać filmów/)).toBeVisible();
  });
});

test.describe('video details', () => {
  test('player, subtitles and the back link', async ({ page }) => {
    await mockApi(page, {
      search: () => ({
        videos: [video('v1', 'Film z napisami', { videoId: 'e2eid12345' })],
        totalCount: 1,
      }),
      details: {
        details: {
          title: 'Film z napisami',
          description: 'Opis',
          uploadDate: '20240615',
          duration: '10:30',
          viewCount: 1234,
          likeCount: 0,
          channelName: 'Kanał E2E',
          comments: [{ id: 'e2e-c1', text: 'Komentarz pierwszy' }],
          commentCount: 2,
          videoPath: 'v1.mp4',
          thumbnailPath: 'v1.webp',
          subtitlePath: 'v1.en.vtt',
          subtitles: [{ path: 'v1.en.vtt', lang: 'en' }],
          folderPath: '/videos/e2e',
        },
      },
    });

    await page.goto('/');

    // The card opens the detail page in a new tab (target=_blank) — the
    // context-wide route mocks apply to the popup as well
    const [detailPage] = await Promise.all([
      page.context().waitForEvent('page'),
      page.getByText('Film z napisami').click(),
    ]);
    await detailPage.waitForLoadState();

    const player = detailPage.getByTestId('video-player');
    await expect(player).toBeVisible();
    await expect(player).toHaveAttribute('src', `/api/videos/file/v1.mp4?folder=${encodeURIComponent('/videos/e2e')}`);
    const track = player.locator('track');
    await expect(track).toHaveAttribute('kind', 'subtitles');
    await expect(track).toHaveAttribute('srcLang', 'en');
    await expect(track).toHaveAttribute('label', 'Angielski');
    await expect(track).toHaveAttribute(
      'src',
      `/api/videos/file/v1.en.vtt?folder=${encodeURIComponent('/videos/e2e')}`,
    );
    await expect(detailPage.getByText('Streszczenie E2E')).toBeVisible();

    // the first page of comments comes with details; more are paged in
    await expect(detailPage.getByText('Komentarz pierwszy')).toBeVisible();
    await detailPage.getByRole('button', { name: 'Pokaż więcej komentarzy (1/2)' }).click();
    await expect(detailPage.getByText('Komentarz drugi')).toBeVisible();

    await detailPage.getByRole('link', { name: '← Wróć do wyszukiwania' }).click();
    await expect(detailPage).toHaveURL(/\/$/);
  });

  test('a details failure shows the message and the back link', async ({ page }) => {
    await mockApi(page, {
      search: () => ({ videos: [video('v1', 'Film bez szczegółów', { videoId: 'e2eid12345' })], totalCount: 1 }),
    });
    // Registered after mockApi, so this route wins for the details endpoint.
    // It must be a CONTEXT route: the card opens the detail page in a new
    // page (target=_blank) and page-level routes do not apply there.
    await page.context().route('**/api/videos/**/details', (route) => route.fulfill(json({ error: 'nope' }, 500)));

    await page.goto('/');

    const [detailPage] = await Promise.all([
      page.context().waitForEvent('page'),
      page.getByText('Film bez szczegółów').click(),
    ]);
    await detailPage.waitForLoadState();

    await expect(detailPage.getByText(/^Błąd:/)).toBeVisible();
    await expect(detailPage.getByRole('link', { name: '← Wróć do wyszukiwania' })).toBeVisible();
  });
});

test.describe('status page', () => {
  test('shows the folders and their configuration', async ({ page }) => {
    await mockApi(page);

    await page.goto('/download');

    await expect(page.getByText('Konfiguracja folderów wideo')).toBeVisible();
    await expect(page.getByText('/videos/e2e')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Edytuj konfigurację' })).toBeVisible();
    // The download page is reachable through the gear menu; the brand link
    // leads back to the list.
    await page.getByRole('button', { name: 'Menu aplikacji' }).click();
    await expect(page.getByRole('menuitem', { name: 'Pobieranie filmów' })).toBeVisible();
  });

  test('queue controls: pause and resume', async ({ page }) => {
    await mockApi(page);

    await page.goto('/download');

    await expect(page.getByRole('button', { name: 'Pauza kolejki' })).toBeVisible();
    await page.getByRole('button', { name: 'Pauza kolejki' }).click();

    await expect(page.getByRole('button', { name: 'Wznów kolejkę' })).toBeVisible();
    await page.getByRole('button', { name: 'Wznów kolejkę' }).click();
    await expect(page.getByRole('button', { name: 'Pauza kolejki' })).toBeVisible();
  });
});
