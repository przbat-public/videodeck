import type { Locator, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { mockApi } from './helpers';

/** Computed outline + shadow of the item, the two leak channels for focus styles */
function itemState(item: Locator): Promise<{ outlineStyle: string; boxShadow: string }> {
  return item.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { outlineStyle: cs.outlineStyle, boxShadow: cs.boxShadow };
  });
}

test.describe('select and date controls', () => {
  test('hovering items shows a clean highlight, before and after touching the date input', async ({ page }) => {
    await mockApi(page, { search: () => ({ videos: [], totalCount: 0 }) });
    await page.goto('/videos');

    const sort = page.getByRole('combobox', { name: 'Sort' });
    const content = page.locator('.ui-select-content');
    const item = content.locator('.ui-select-item').nth(1);

    await sort.click();
    await expect(content).toBeVisible();
    await item.hover();
    await expect(item).toHaveAttribute('data-highlighted');
    const first = await itemState(item);
    await page.keyboard.press('Escape');

    // Touching the calendar used to change how the list rendered on hover
    await page.getByLabel('Od daty').click();
    await page.keyboard.press('Escape');
    await sort.click();
    await expect(content).toBeVisible();
    await item.hover();
    await expect(item).toHaveAttribute('data-highlighted');
    const second = await itemState(item);

    expect(first.outlineStyle).toBe('none');
    expect(first.boxShadow).toBe('none');
    expect(second.outlineStyle).toBe('none');
    expect(second.boxShadow).toBe('none');
  });

  test('keyboard navigation keeps a visible focus indicator on the item', async ({ page }) => {
    await mockApi(page, { search: () => ({ videos: [], totalCount: 0 }) });
    await page.goto('/videos');

    const sort = page.getByRole('combobox', { name: 'Sort' });
    const content = page.locator('.ui-select-content');

    // The previous test may leave the pointer over the list; a hovering
    // pointer would legitimately suppress the keyboard ring, so park the
    // mouse in the top corner where the list never opens.
    await page.mouse.move(0, 0);
    await sort.focus();

    await page.keyboard.press('Enter');
    await expect(content).toBeVisible();
    await page.keyboard.press('ArrowDown');

    const highlighted = content.locator('.ui-select-item[data-highlighted]');
    await expect(highlighted).toHaveCount(1);

    // Radix lands the focus asynchronously after the arrow key, so poll for
    // the settled state: the focused option carries the inset ring and the
    // leaky outline stays suppressed.
    await expect
      .poll(() =>
        page.evaluate(() => {
          const active = document.activeElement;
          if (!(active instanceof HTMLElement) || !active.classList.contains('ui-select-item')) {
            return '';
          }
          return getComputedStyle(active).boxShadow;
        }),
      )
      .toContain('inset');
    const state = await itemState(highlighted);
    expect(state.outlineStyle).toBe('none');
  });

  test('native date inputs follow the dark theme', async ({ page }: { page: Page }) => {
    await mockApi(page, { search: () => ({ videos: [], totalCount: 0 }) });
    await page.goto('/videos');

    const theme = page.getByRole('combobox', { name: 'Motyw' });
    await theme.click();
    await page.getByRole('option', { name: 'Ciemny' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    const scheme = await page.getByLabel('Od daty').evaluate((el) => getComputedStyle(el).colorScheme);
    expect(scheme).toBe('dark');
  });
});
