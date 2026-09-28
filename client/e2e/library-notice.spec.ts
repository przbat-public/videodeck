import { expect, test } from '@playwright/test';
import { mockApi } from './helpers';

/**
 * The browser layer for the "a drive arrived" notice. The mocked stream opens
 * with the library and then delivers one change, which is exactly what a
 * plugged drive looks like to the client. Whether the reindex really runs is
 * the integration suite's job; here the point is that the notice renders with
 * its count and that its one action is reachable.
 */

/** A channel folder the library gained while the page was open */
const ARRIVED_FRAME = {
  type: 'library',
  revision: 2,
  folders: ['/videos/e2e', '/videos/new-drive'],
  unavailable: [],
  added: ['/videos/new-drive'],
};

test.describe('a drive that arrives while the page is open', () => {
  test('announces the new channels and offers the one action that indexes them', async ({ page }) => {
    await mockApi(page, { libraryFrames: [ARRIVED_FRAME] });
    await page.goto('/');

    // By class: the loading spinner and the toasts are role="status" regions too
    const notice = page.locator('.library-notice');
    await expect(notice).toContainText('Wykryto 1 nowy kanał na dysku');
    await expect(notice.getByRole('button', { name: 'Zaindeksuj nowe kanały' })).toBeEnabled();
    await expect(notice.getByRole('button', { name: 'Ukryj' })).toBeVisible();
  });
});
