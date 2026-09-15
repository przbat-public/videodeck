import { expect, type Page, test } from '@playwright/test';
import { mockApi, video } from './helpers';

/**
 * Responsive regression guard, per DESIGN.md section 11 and the
 * responsive-design skill: no horizontal overflow at the three contract
 * viewports, the play overlay reachable by keyboard, 16px text inputs,
 * 44px touch targets on phones, the player geometry, and an approximated
 * 200 percent zoom reflow check at the 320px equivalent.
 */

const VIEWPORTS = [
  { name: 'phone-360', width: 360, height: 800 },
  { name: 'tablet-768', width: 768, height: 1024 },
  { name: 'desktop-1280', width: 1280, height: 720 },
];

/** Interactive elements whose hit area must reach 44x44px on touch */
const TOUCH_SELECTOR =
  'button, select, a, input:not(.ui-checkbox-input), [role="button"], [role="combobox"], label.ui-checkbox';

async function searchPage(page: Page): Promise<void> {
  await mockApi(page, {
    search: () => ({
      videos: [
        video('v1', 'Silnik krokowy'),
        video('v2', 'Bardzo długi tytuł filmu który testuje zawijanie tekstu na małym ekranie'),
      ],
      totalCount: 2,
    }),
  });
  await page.goto('/videos');
  await page.locator('.video-card').first().waitFor();
}

const horizontalOverflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

// WCAG contrast scanning. page.evaluate serializes only the function it
// receives, so everything the browser needs lives inside this one function.

type Rgb = [number, number, number];

/** Visible interactive elements whose hit area misses 44x44px */
function scanTouchTargets(selector: string): Array<{ tag: string; cls: string; text: string; w: number; h: number }> {
  const hits: Array<{ tag: string; cls: string; text: string; w: number; h: number }> = [];
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
    if (el.getAttribute('aria-hidden') === 'true') {
      continue;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      continue;
    }
    if (rect.width < 44 || rect.height < 44) {
      hits.push({
        tag: el.tagName.toLowerCase(),
        cls: el.className?.toString().slice(0, 50) ?? '',
        text: (el.textContent ?? '').trim().slice(0, 24),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      });
    }
  }
  return hits;
}

/** Text nodes whose contrast with their background misses WCAG AA */
function scanTextContrast(): Array<{ text: string; ratio: number }> {
  const luminance = (rgb: Rgb): number => {
    const channel = (component: number): number => {
      const scaled = component / 255;
      return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
  };
  const contrast = (fore: Rgb, back: Rgb): number => {
    const first = luminance(fore);
    const second = luminance(back);
    return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
  };
  const parse = (color: string): Rgb | null => {
    const match = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
  };
  const background = (el: Element): Rgb => {
    let node: Element | null = el;
    while (node) {
      const parsed = parse(window.getComputedStyle(node).backgroundColor);
      const transparent = window.getComputedStyle(node).backgroundColor.includes('0, 0, 0, 0');
      if (parsed && !transparent) {
        return parsed;
      }
      node = node.parentElement;
    }
    return [255, 255, 255];
  };

  const violations: Array<{ text: string; ratio: number }> = [];
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
    // Media surfaces (thumbnail, player) are the deliberate black
    // backgrounds from the contract; walking through the poster image
    // would misreport white-on-image as a violation.
    if (el.closest('.video-thumbnail, .video-player-section, video') || el.tagName === 'TITLE') {
      continue;
    }
    const direct = Array.from(el.childNodes).some(
      (node) => node.nodeType === 3 && (node.textContent ?? '').trim().length > 0,
    );
    if (!direct) {
      continue;
    }
    const fore = parse(window.getComputedStyle(el).color);
    if (!fore) {
      continue;
    }
    const size = parseFloat(window.getComputedStyle(el).fontSize);
    const bold = parseInt(window.getComputedStyle(el).fontWeight, 10) >= 700;
    const threshold = size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5;
    const ratio = contrast(fore, background(el));
    if (ratio < threshold) {
      violations.push({ text: (el.textContent ?? '').trim().slice(0, 40), ratio: Math.round(ratio * 100) / 100 });
    }
  }
  return violations;
}

test.describe('responsive contract', () => {
  for (const viewport of VIEWPORTS) {
    test(`no horizontal overflow on the search page at ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await searchPage(page);
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    });

    test(`no horizontal overflow on the status page at ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await mockApi(page);
      await page.goto('/');
      await page.locator('.status-page').waitFor();
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    });

    test(`no horizontal overflow on the detail page at ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await mockApi(page);
      await page.goto('/video/deepE2e0001');
      await page.locator('.video-detail-page').waitFor();
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    });
  }

  test('the card play overlay appears on keyboard focus', async ({ page }) => {
    await searchPage(page);
    const overlay = page.locator('.play-overlay').first();
    await expect(overlay).toHaveCSS('opacity', '0');
    await page.locator('.video-card-link').first().focus();
    await expect(overlay).toHaveCSS('opacity', '1');
  });

  test('search inputs keep a 16px font so iOS never zooms', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await searchPage(page);
    const fontSizes = await page.evaluate(() =>
      ['.channel-input', '.date-filter'].map((selector) => {
        const element = document.querySelector<HTMLElement>(selector);
        return element ? parseFloat(window.getComputedStyle(element).fontSize) : 0;
      }),
    );
    for (const size of fontSizes) {
      expect(size).toBeGreaterThanOrEqual(16);
    }
  });

  test('every touch target reaches 44x44px on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await searchPage(page);
    for (const url of ['/videos', '/']) {
      await page.goto(url);
      await page.locator('.app-main').waitFor();
      const undersized = await page.evaluate(scanTouchTargets, TOUCH_SELECTOR);
      expect(undersized, `undersized touch targets on ${url}`).toEqual([]);
    }
  });

  test('the detail player fills the phone width and keeps 16:9', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await mockApi(page);
    await page.goto('/video/deepE2e0001');
    const player = page.locator('.video-player-full');
    await player.waitFor();
    await expect(player).toHaveCSS('aspect-ratio', '16 / 9');
    const widths = await player.evaluate((el) => ({
      player: el.getBoundingClientRect().width,
      container: (el.parentElement ?? el).getBoundingClientRect().width,
    }));
    expect(Math.abs(widths.player - widths.container)).toBeLessThanOrEqual(2);
  });

  test('200 percent zoom reflows without horizontal scroll', async ({ page }) => {
    // Browser zoom halves the CSS viewport, so 200 percent on a 640px
    // window equals a 320px layout width, the WCAG reflow benchmark.
    await page.setViewportSize({ width: 320, height: 800 });
    await searchPage(page);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  });
});

test.describe('theme contrast', () => {
  for (const theme of ['light', 'dark'] as const) {
    test(`text keeps WCAG AA contrast in the ${theme} theme`, async ({ page }) => {
      await mockApi(page, {
        search: () => ({
          videos: [video('v1', 'Silnik krokowy'), video('v2', 'Długi tytuł testowy na małym ekranie')],
          totalCount: 2,
        }),
      });
      for (const url of ['/videos', '/', '/video/deepE2e0001']) {
        await page.setViewportSize({ width: 360, height: 800 });
        await page.goto(url);
        await page.evaluate((next) => {
          document.documentElement.setAttribute('data-theme', next);
        }, theme);
        // The switcher colors transition over 150ms; scanning mid-transition
        // would report the in-between color as a contrast miss. Wait for the
        // settled value of the one element that transitions.
        const settledMuted: Record<'light' | 'dark', string> = {
          light: 'rgb(102, 102, 102)',
          dark: 'rgb(154, 160, 166)',
        };
        const settled = settledMuted[theme];
        await expect(page.locator('.language-switcher-option:not(.active)').first()).toHaveCSS('color', settled);
        const violations = await page.evaluate(scanTextContrast);
        expect(violations, `contrast violations on ${url} in the ${theme} theme`).toEqual([]);
      }
    });
  }
});
