import { expect, test } from '@playwright/test';
import { mockApi, video } from './helpers';

test.describe('wyszukiwarka', () => {
  test('adres URL steruje formularzem i wynikami', async ({ page }) => {
    await mockApi(page, {
      search: (params) => {
        expect(params.get('q')).toBe('motor');
        expect(params.get('sort')).toBe('views-desc');
        expect(params.get('category')).toBe('fpv');
        expect(params.get('offset')).toBe('0');
        return { videos: [video('v1', 'Silnik krokowy')], totalCount: 1 };
      },
    });

    await page.goto('/videos?q=motor&sort=views-desc&category=fpv');

    await expect(page.getByPlaceholder('Szukaj filmów po opisie...')).toHaveValue('motor');
    await expect(page.locator('.sort-select')).toContainText('Najwięcej wyświetleń');
    await expect(page.locator('.category-select')).toContainText('fpv');
    await expect(page.getByText('Silnik krokowy')).toBeVisible();
    // the URL is not rewritten for valid parameters
    expect(new URL(page.url()).search).toContain('q=motor');
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
    await page.locator('.sort-select').click();
    await page.getByRole('option', { name: 'Najnowsze' }).click();

    await expect(page.locator('.sort-select')).toContainText('Najnowsze');
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
    await expect(page.getByRole('button', { name: 'Pokaż więcej' })).not.toBeVisible();
    await expect(page.locator('.video-count')).toHaveText('2 filmy / 2 łącznie');
  });

  test('pusta fraza pokazuje komunikat braku wyników', async ({ page }) => {
    await mockApi(page, { search: () => ({ videos: [], totalCount: 0 }) });

    await page.goto('/videos');

    await expect(page.getByText('Brak filmów. Spróbuj innego zapytania.')).toBeVisible();
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
          comments: [],
          commentCount: 0,
          videoPath: 'v1.mp4',
          thumbnailPath: 'v1.webp',
          subtitlePath: 'v1.en.vtt',
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
    await expect(player).toHaveAttribute(
      'src',
      `/api/videos/file/v1.mp4?folder=${encodeURIComponent('/videos/e2e')}`
    );
    const track = player.locator('track');
    await expect(track).toHaveAttribute('kind', 'subtitles');
    await expect(track).toHaveAttribute(
      'src',
      `/api/videos/file/v1.en.vtt?folder=${encodeURIComponent('/videos/e2e')}`
    );
    await expect(detailPage.getByText('Streszczenie E2E')).toBeVisible();

    await detailPage.getByRole('link', { name: '← Wróć do wyszukiwania' }).click();
    await expect(detailPage).toHaveURL(/\/videos/);
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
});
