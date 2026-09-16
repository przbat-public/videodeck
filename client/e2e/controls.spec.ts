import type { Locator } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { mockApi } from './helpers';

/** Computed outline + shadow of the item, the two leak channels for focus styles */
function itemState(item: Locator): Promise<{ outlineStyle: string; boxShadow: string }> {
  return item.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { outlineStyle: cs.outlineStyle, boxShadow: cs.boxShadow };
  });
}

test.describe('select controls', () => {
  test('hovering items shows a clean highlight, before and after touching another control', async ({ page }) => {
    await mockApi(page, { search: () => ({ videos: [], totalCount: 0 }) });
    await page.goto('/');

    const sort = page.getByRole('combobox', { name: 'Sort' });
    const content = page.locator('.ui-select-content');
    const item = content.locator('.ui-select-item').nth(1);

    await sort.click();
    await expect(content).toBeVisible();
    await item.hover();
    await expect(item).toHaveAttribute('data-highlighted');
    const first = await itemState(item);
    await page.keyboard.press('Escape');

    // Touching another control used to change how the list rendered on hover
    await page.getByPlaceholder('Szukaj filmów po opisie...').click();
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
    await page.goto('/');

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

  test('the select trigger draws the tokenized focus ring', async ({ page }) => {
    await mockApi(page, { search: () => ({ videos: [], totalCount: 0 }) });
    await page.goto('/');

    const trigger = page.getByRole('combobox', { name: 'Sort' });
    await trigger.focus();

    // The box-shadow transition takes 0.2s; poll until it settles.
    await expect
      .poll(() => trigger.evaluate((el) => getComputedStyle(el).boxShadow))
      .toContain('rgba(102, 126, 234, 0.2)');
  });
});
