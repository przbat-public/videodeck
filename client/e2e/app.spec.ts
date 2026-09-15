import { expect, test } from '@playwright/test';
import { json, mockApi, video } from './helpers';

test.describe('wyszukiwarka', () => {
  test('adres URL steruje formularzem i wynikami', async ({ page }) => {
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
      '/videos?q=motor&sort=views-desc&category=fpv&channel=Kana%C5%82+E2E&dateFrom=2024-01-05&dateTo=2025-12-31',
    );

    await expect(page.getByPlaceholder('Szukaj filmów po opisie...')).toHaveValue('motor');
    await expect(page.getByRole('combobox', { name: 'Sort' })).toContainText('Najwięcej wyświetleń');
    await expect(page.getByRole('combobox', { name: 'Kategoria' })).toContainText('fpv');
    await expect(page.getByLabel('Kanał')).toHaveValue('Kanał E2E');
    await expect(page.getByLabel('Od daty')).toHaveValue('2024-01-05');
    await expect(page.getByLabel('Do daty')).toHaveValue('2025-12-31');
    await expect(page.getByText('Silnik krokowy')).toBeVisible();
    // the URL is not rewritten for valid parameters
    expect(new URL(page.url()).search).toContain('q=motor');
  });

  test('przełącznik języka zmienia interfejs na angielski i z powrotem', async ({ page }) => {
    await mockApi(page);

    await page.goto('/videos');
    await expect(page.getByPlaceholder('Szukaj filmów po opisie...')).toBeVisible();

    await page.getByRole('button', { name: 'EN' }).click();
    await expect(page.getByPlaceholder('Search videos by description...')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Refresh index' })).toBeVisible();

    await page.getByRole('button', { name: 'PL' }).click();
    await expect(page.getByPlaceholder('Szukaj filmów po opisie...')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Odśwież indeks' })).toBeVisible();
  });

  test('przełącznik motywu ustawia data-theme i pamięta wybór po przeładowaniu', async ({ page }) => {
    await mockApi(page);

    await page.goto('/videos');

    const themeSelect = page.getByRole('combobox', { name: 'Motyw' });
    await themeSelect.click();
    await page.getByRole('option', { name: 'Ciemny' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });

  test('select sortowania otwiera listę i zmienia sortowanie', async ({ page }) => {
    const sorts: (string | null)[] = [];
    await mockApi(page, {
      search: (params) => {
        sorts.push(params.get('sort'));
        return { videos: [], totalCount: 0 };
      },
    });

    await page.goto('/videos');
    await page.getByRole('combobox', { name: 'Sort' }).click();
    await page.getByRole('option', { name: 'Najnowsze' }).click();

    await expect(page.getByRole('combobox', { name: 'Sort' })).toContainText('Najnowsze');
    await expect.poll(() => sorts).toContain('date-desc');
  });

  test('„Pokaż więcej" dokłada kolejną stronę', async ({ page }) => {
    await mockApi(page, {
      search: (params) =>
        params.get('offset') === '1'
          ? { videos: [video('v2', 'Drugi film')], totalCount: 2 }
          : { videos: [video('v1', 'Pierwszy film')], totalCount: 2 },
    });

    await page.goto('/videos');
    await expect(page.getByText('Pierwszy film')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Pokaż więcej' })).toBeVisible();

    await page.getByRole('button', { name: 'Pokaż więcej' }).click();

    await expect(page.getByText('Drugi film')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Pokaż więcej' })).toBeHidden();
    await expect(page.getByText('2 filmy / 2 łącznie')).toBeVisible();
  });

  test('pusta fraza pokazuje komunikat braku wyników', async ({ page }) => {
    await mockApi(page, { search: () => ({ videos: [], totalCount: 0 }) });

    await page.goto('/videos');

    await expect(page.getByText('Brak filmów. Spróbuj innego zapytania.')).toBeVisible();
  });

  test('Enter zatwierdza wpisaną frazę z klawiatury', async ({ page }) => {
    const queries: (string | null)[] = [];
    await mockApi(page, {
      search: (params) => {
        queries.push(params.get('q'));
        return { videos: [video('v1', 'Film z Entera')], totalCount: 1 };
      },
    });

    await page.goto('/videos');

    const input = page.getByLabel('Fraza wyszukiwania');
    await input.fill('dron');
    await input.press('Enter');

    await expect(page.getByText('Film z Entera')).toBeVisible();
    // The initial (empty-phrase) search resolves first and also matches the
    // mock — wait for the Enter-committed search to actually hit the API
    await expect.poll(() => queries).toContain('dron');
  });

  test('błąd wyszukiwania pokazuje toast z komunikatem', async ({ page }) => {
    await mockApi(page);
    // Registered after mockApi, so this route wins for the search endpoint
    await page.route('**/api/videos/search**', (route) => route.fulfill(json({ error: 'Elasticsearch is down' }, 500)));

    await page.goto('/videos');

    await expect(page.getByText(/Nie udało się wyszukać filmów/)).toBeVisible();
  });
});

test.describe('szczegóły filmu', () => {
  test('odtwarzacz, napisy i link powrotu', async ({ page }) => {
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

    await page.goto('/videos');

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
    await expect(detailPage).toHaveURL(/\/videos/);
  });

  test('błąd pobierania szczegółów pokazuje komunikat i link powrotu', async ({ page }) => {
    await mockApi(page, {
      search: () => ({ videos: [video('v1', 'Film bez szczegółów', { videoId: 'e2eid12345' })], totalCount: 1 }),
    });
    // Registered after mockApi, so this route wins for the details endpoint.
    // It must be a CONTEXT route: the card opens the detail page in a new
    // page (target=_blank) and page-level routes do not apply there.
    await page.context().route('**/api/videos/**/details', (route) => route.fulfill(json({ error: 'nope' }, 500)));

    await page.goto('/videos');

    const [detailPage] = await Promise.all([
      page.context().waitForEvent('page'),
      page.getByText('Film bez szczegółów').click(),
    ]);
    await detailPage.waitForLoadState();

    await expect(detailPage.getByText(/^Błąd:/)).toBeVisible();
    await expect(detailPage.getByRole('link', { name: '← Wróć do wyszukiwania' })).toBeVisible();
  });
});

test.describe('strona statusu', () => {
  test('pokazuje foldery i konfigurację', async ({ page }) => {
    await mockApi(page);

    await page.goto('/');

    await expect(page.getByText('Konfiguracja folderów wideo')).toBeVisible();
    await expect(page.getByText('/videos/e2e')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Edytuj konfigurację' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Przejdź do listy filmów' })).toBeVisible();
  });

  test('kontrolki kolejki: pauza i wznów', async ({ page }) => {
    await mockApi(page);

    await page.goto('/');

    await expect(page.getByRole('button', { name: 'Pauza kolejki' })).toBeVisible();
    await page.getByRole('button', { name: 'Pauza kolejki' }).click();

    await expect(page.getByRole('button', { name: 'Wznów kolejkę' })).toBeVisible();
    await page.getByRole('button', { name: 'Wznów kolejkę' }).click();
    await expect(page.getByRole('button', { name: 'Pauza kolejki' })).toBeVisible();
  });
});
