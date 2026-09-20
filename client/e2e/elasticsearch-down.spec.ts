import { expect, test } from '@playwright/test';
import { json, mockApi } from './helpers';

/**
 * The outage banner and the messages around it. Everything here is the
 * mocked-API layer: the point is that a 503 from the readiness probe or from a
 * search turns into one banner and a sentence a user can act on, while the
 * pages that work from disk keep working.
 */

const DOWN_HEALTH = { status: 'degraded', elasticsearch: 'down' };

test.describe('Elasticsearch down', () => {
  test('shows one banner, turns the index actions off and clears on retry', async ({ page }) => {
    await mockApi(page, { health: DOWN_HEALTH });
    await page.goto('/');

    // By class: the loading spinner is a role="status" live region too
    const banner = page.locator('.health-banner');
    await expect(banner).toContainText('Elasticsearch nie odpowiada');
    await expect(banner).toContainText('pobieranie i lista filmów działają dalej');

    // The index actions need the cluster, and the banner says why they are off
    await page.getByRole('button', { name: 'Menu aplikacji' }).click();
    await expect(page.getByRole('menuitem', { name: 'Odśwież indeks' })).toHaveAttribute('data-disabled', '');
    await expect(page.getByRole('menuitem', { name: 'Odbuduj indeksy' })).toHaveAttribute('data-disabled', '');
    await page.keyboard.press('Escape');

    // The cluster comes back (by hand here: the dev proxy answers again), and
    // the banner's retry is the user-visible way to notice
    await page.context().route('**/api/health', (route) => route.fulfill(json({ status: 'ok', elasticsearch: 'ok' })));
    await page.getByRole('button', { name: 'Sprawdź ponownie' }).click();

    await expect(page.locator('.health-banner')).toHaveCount(0);
    await page.getByRole('button', { name: 'Menu aplikacji' }).click();
    await expect(page.getByRole('menuitem', { name: 'Odśwież indeks' })).not.toHaveAttribute('data-disabled', '');
  });

  test('a search that fails on the cluster says so instead of showing no results', async ({ page }) => {
    await mockApi(page, { health: DOWN_HEALTH });
    // Registered after mockApi, so the failing search wins for this test
    await page
      .context()
      .route('**/api/videos/search**', (route) =>
        route.fulfill(json({ error: 'Elasticsearch is not reachable', code: 'elasticsearch_unavailable' }, 503)),
      );
    await page.goto('/');

    await page.getByLabel('Fraza wyszukiwania').fill('gleboka');
    await page.keyboard.press('Enter');

    // The results area prefixes its messages with "Błąd:", hence the regex
    await expect(page.getByText(/Nie udało się wyszukać filmów: Elasticsearch nie odpowiada/).first()).toBeVisible();
    // Not the empty-result copy, and not a page-level "something went wrong"
    await expect(page.getByText('Brak filmów. Spróbuj innego zapytania.')).toHaveCount(0);
    await expect(page.locator('.health-banner')).toContainText('Elasticsearch nie odpowiada');
  });

  test('the download console still renders its channels from disk', async ({ page }) => {
    await mockApi(page, { health: DOWN_HEALTH });
    await page.goto('/download');

    await expect(page.locator('.health-banner')).toContainText('Elasticsearch nie odpowiada');
    // The row is there, and it does not claim the channel lost its index
    await expect(page.getByText('/videos/e2e')).toBeVisible();
    await expect(page.getByText('brak indeksu ES')).toHaveCount(0);
  });
});
