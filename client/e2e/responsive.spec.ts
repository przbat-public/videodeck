import { expect, type Page, test } from '@playwright/test';
import type { MockApiHandlers } from './helpers';
import { expandChannel, json, mockApi, video } from './helpers';

/**
 * Responsive regression guard, per DESIGN.md section 11 and the
 * responsive-design skill: no horizontal overflow at the three contract
 * viewports, the play overlay reachable by keyboard, 16px text inputs,
 * 44px touch targets on phones, the player geometry, and an approximated
 * 200 percent zoom reflow check at the 320px equivalent.
 */

/**
 * The two surfaces the shell can show on top of a page: the outage banner and
 * the "a drive arrived" strip. The contract probes below run with them in the
 * DOM, because a regression in a always-mounted row is exactly what a probe
 * that never mounts it cannot see.
 */
const SHELL_SURFACES: Partial<MockApiHandlers> = {
  health: { status: 'degraded', elasticsearch: 'down', revision: 1 },
  libraryFrames: [
    {
      type: 'library',
      revision: 2,
      folders: ['/videos/e2e', '/videos/plugged-in'],
      unavailable: [],
      added: ['/videos/plugged-in'],
    },
  ],
};

/** Fail loudly when a fixture stopped producing the surface it exists for */
async function expectShellSurfaces(page: Page): Promise<void> {
  await expect(page.locator('.health-banner')).toBeVisible();
  await expect(page.locator('.library-notice')).toBeVisible();
}

const VIEWPORTS = [
  { name: 'phone-360', width: 360, height: 800 },
  { name: 'tablet-768', width: 768, height: 1024 },
  { name: 'desktop-1280', width: 1280, height: 720 },
];

/** Interactive elements whose hit area must reach 44x44px on touch */
const TOUCH_SELECTOR = 'button, select, a, input, [role="button"], [role="combobox"], label.ui-checkbox';

async function searchPage(page: Page, extra: Partial<MockApiHandlers> = {}): Promise<void> {
  await mockApi(page, {
    search: () => ({
      videos: [
        video('v1', 'Silnik krokowy'),
        video('v2', 'Bardzo długi tytuł filmu który testuje zawijanie tekstu na małym ekranie'),
      ],
      totalCount: 2,
    }),
    ...extra,
  });
  await page.goto('/');
  await page.locator('.video-card').first().waitFor();
}

const horizontalOverflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

/** The status page's folder section with every bulk button visible */
async function folderListPage(page: Page): Promise<void> {
  await mockApi(page, {
    status: {
      videosFolderPath: ['/videos/e2e'],
      folderConfigs: { '/videos/e2e': { channelUrl: 'https://yt/@e2e', category: 'fpv' } },
      downloadDefaults: { maxHeight: 2160, subLangs: ['en'], writeComments: true },
      indexedFolders: ['/videos/e2e'],
      listExists: { '/videos/e2e': true },
      unavailableFolders: [],
      status: 'ok',
      elasticsearch: 'ok',
    },
    list: {
      videos: [
        { id: 'v1', title: 'Pobrany dawno temu', url: 'https://yt/v1' },
        { id: 'v2', title: 'Jeszcze nie pobrany', url: 'https://yt/v2' },
      ],
      downloadStatuses: { v1: true },
      lastUpdatedDates: { v1: '2020-01-01T00:00:00.000Z' },
    },
  });
  // mockApi answers the queue with no jobs; a running one is needed for the
  // fourth bulk button, so this route is registered after it (and thus wins).
  await page.route(/\/api\/folder\/queue/, (route) =>
    route.fulfill(
      json({
        paused: false,
        total: 1,
        jobs: [
          {
            id: 'job-1',
            folderPath: '/videos/e2e',
            videoId: 'v2',
            videoUrl: 'https://yt/v2',
            title: 'Jeszcze nie pobrany',
            type: 'download',
            status: 'running',
            progress: 30,
            log: [],
            logLineCount: 0,
            createdAt: '2026-01-01T10:00:00.000Z',
          },
        ],
      }),
    ),
  );
  await page.goto('/download');
  await expandChannel(page);
  await page.getByText('Pobrany dawno temu').waitFor();
}

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
      await page.goto('/download');
      await page.locator('.status-page').waitFor();
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    });

    test(`no horizontal overflow with the shell surfaces at ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await searchPage(page, SHELL_SURFACES);
      await expectShellSurfaces(page);
      for (const url of ['/', '/download']) {
        await page.goto(url);
        await page.locator('.app-main').waitFor();
        expect(await horizontalOverflow(page), `overflow on ${url}`).toBeLessThanOrEqual(0);
      }
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
      ['.channel-select'].map((selector) => {
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
    // With the shell surfaces mounted, so the strip's two buttons are measured
    await searchPage(page, SHELL_SURFACES);
    for (const url of ['/', '/download']) {
      await page.goto(url);
      await page.locator('.app-main').waitFor();
      const undersized = await page.evaluate(scanTouchTargets, TOUCH_SELECTOR);
      expect(undersized, `undersized touch targets on ${url}`).toEqual([]);
    }
    await page.goto('/download');
    await expectShellSurfaces(page);
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

/** Open one page in the given theme and return the contrast violations */
async function collectContrastViolations(
  page: Page,
  url: string,
  theme: 'light' | 'dark',
): Promise<Array<{ text: string; ratio: number }>> {
  // The theme hook resolves the stored choice at startup, so seed it before
  // navigation instead of flipping the attribute after load (the hook would
  // write its own resolved value on mount and clobber the late change).
  await page.addInitScript((stored) => {
    window.localStorage.setItem('videodeck-theme', stored);
  }, theme);
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto(url);
  return page.evaluate(scanTextContrast);
}

test.describe('theme contrast', () => {
  for (const theme of ['light', 'dark'] as const) {
    test(`text keeps WCAG AA contrast in the ${theme} theme`, async ({ page }) => {
      await mockApi(page, {
        search: () => ({
          videos: [video('v1', 'Silnik krokowy'), video('v2', 'Długi tytuł testowy na małym ekranie')],
          totalCount: 2,
        }),
        ...SHELL_SURFACES,
      });
      await page.goto('/download');
      await expectShellSurfaces(page);
      for (const url of ['/', '/download', '/video/deepE2e0001']) {
        const violations = await collectContrastViolations(page, url, theme);
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        expect(violations, `contrast violations on ${url} in the ${theme} theme`).toEqual([]);
      }
    });
  }
});

test.describe('reported layout defects', () => {
  test('the search page does not overflow at 1024px', async ({ page }) => {
    // The filter row used to run off the right edge between 768 and ~1100px.
    await page.setViewportSize({ width: 1024, height: 900 });
    await searchPage(page);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  });

  test('text inputs use the theme surface in dark mode', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await searchPage(page);
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'dark');
    });
    const backgrounds = await page.evaluate(() =>
      ['.search-input', '.channel-select'].map((selector) => {
        const el = document.querySelector<HTMLElement>(selector);
        return el ? window.getComputedStyle(el).backgroundColor : 'missing';
      }),
    );
    for (const background of backgrounds) {
      expect(background).not.toBe('rgb(255, 255, 255)');
    }
  });

  test('the top bar never overlaps the search bar', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await searchPage(page);
    const overlap = await page.evaluate(() => {
      const bar = document.querySelector<HTMLElement>('.app-topbar');
      const search = document.querySelector<HTMLElement>('.search-bar');
      if (!bar || !search) return true;
      const a = bar.getBoundingClientRect();
      const b = search.getBoundingClientRect();
      return a.bottom > b.top && a.top < b.bottom && a.right > b.left && a.left < b.right;
    });
    expect(overlap).toBe(false);
  });

  test('the top bar shares the 2rem page rhythm above it, halved on a phone', async ({ page }) => {
    const topPadding = () => page.locator('.app-topbar').evaluate((el) => getComputedStyle(el).paddingTop);

    await page.setViewportSize({ width: 1280, height: 720 });
    await searchPage(page);
    expect(await topPadding()).toBe('32px');

    await page.setViewportSize({ width: 360, height: 800 });
    await searchPage(page);
    expect(await topPadding()).toBe('16px');
  });

  test('the gear menu trigger keeps a 44x44px touch target on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await searchPage(page);
    const box = await page.locator('.ui-menu-trigger').evaluate((el) => {
      const rect = el.getBoundingClientRect();
      return { width: Math.round(rect.width), height: Math.round(rect.height) };
    });
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  });

  test('the videos sit on the row surface, half a rhythm under it, with no card', async ({ page }) => {
    // The section opened with a 1.5rem margin, 1.5rem padding and a border
    // line above it: three rhythms of air inside a row that already sits in
    // the table. A 0.5rem margin is all that separates it from the row now,
    // and the cell itself is the surface: an inner card framed nothing.
    await page.setViewportSize({ width: 1280, height: 720 });
    await folderListPage(page);
    const spacing = await page.locator('.videos-list').evaluate((el) => {
      const style = getComputedStyle(el);
      return { marginTop: style.marginTop, paddingTop: style.paddingTop, borderTopWidth: style.borderTopWidth };
    });
    expect(spacing).toEqual({ marginTop: '8px', paddingTop: '0px', borderTopWidth: '0px' });

    const cell = await page.locator('.channel-expanded-row > td').evaluate((el) => {
      // The filter chips sit above the list, so "no card in between" means the
      // list hangs off the cell itself rather than inside a wrapper of its own
      const list = el.querySelector(':scope > .videos-list');
      return {
        background: getComputedStyle(el).backgroundColor,
        listIsDirectChild: list !== null,
        listBackground: list === null ? '' : getComputedStyle(list).backgroundColor,
      };
    });
    expect(cell.background).toBe('rgb(255, 255, 255)');
    expect(cell.listIsDirectChild).toBe(true);
    expect(cell.listBackground).toBe('rgba(0, 0, 0, 0)');
  });
});

test.describe('long unbroken content', () => {
  const unbroken = 'z'.repeat(220);

  test('an unbroken card title clamps to two lines instead of widening the page', async ({ page }) => {
    await mockApi(page, {
      search: () => ({ videos: [video('v1', unbroken), video('v2', 'Silnik krokowy')], totalCount: 2 }),
    });
    for (const width of [360, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/');
      const title = page.locator('.video-title').first();
      await title.waitFor();
      expect(await title.evaluate((el) => getComputedStyle(el).webkitLineClamp)).toBe('2');
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    }
  });

  test('an unbroken description wraps on the detail page', async ({ page }) => {
    await mockApi(page, {
      details: {
        details: {
          title: 'Szczegóły filmu',
          description: 'opis'.repeat(400),
          uploadDate: '20240615',
          duration: '10:30',
          viewCount: 1234,
          likeCount: 56,
          channelName: 'Kanał E2E',
          comments: [],
          commentCount: 0,
          videoPath: 'hedgehogs.mp4',
          thumbnailPath: 'hedgehogs.webp',
          subtitles: [],
          folderPath: '/videos/e2e',
        },
      },
    });
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto('/video/deepE2e0001');
    await page.locator('.video-detail-page').waitFor();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  });

  test('an unbroken queue row title wraps on the status page', async ({ page }) => {
    await mockApi(page, {
      status: {
        videosFolderPath: ['/videos/e2e'],
        folderConfigs: { '/videos/e2e': { channelUrl: 'https://yt/@e2e', category: 'fpv' } },
        downloadDefaults: { maxHeight: 2160, subLangs: ['en'], writeComments: true },
        indexedFolders: ['/videos/e2e'],
        listExists: { '/videos/e2e': true },
        unavailableFolders: [],
        status: 'ok',
        elasticsearch: 'ok',
      },
      list: {
        videos: [{ id: 'v1', title: unbroken, url: 'https://yt/v1' }],
        downloadStatuses: {},
        lastUpdatedDates: {},
      },
    });
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto('/download');
    await expandChannel(page);
    await page.getByText(unbroken.slice(0, 40)).waitFor();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  });

  test('a row carrying an error log does not overlap the row below it', async ({ page }) => {
    // The windowed list sized every row from three fixed constants, so an
    // error row (title + failure box + up to a 200px log) painted over its
    // neighbour.
    const log = Array.from({ length: 20 }, (_, index) => `ERROR: line ${index} of the yt-dlp output`);
    await mockApi(page, {
      status: {
        videosFolderPath: ['/videos/e2e'],
        folderConfigs: { '/videos/e2e': { channelUrl: 'https://yt/@e2e', category: 'fpv' } },
        downloadDefaults: { maxHeight: 2160, subLangs: ['en'], writeComments: true },
        indexedFolders: ['/videos/e2e'],
        listExists: { '/videos/e2e': true },
        unavailableFolders: [],
        status: 'ok',
        elasticsearch: 'ok',
      },
      list: {
        videos: [
          { id: 'v1', title: 'Pierwszy film', url: 'https://yt/v1' },
          { id: 'v2', title: 'Drugi film', url: 'https://yt/v2' },
        ],
        downloadStatuses: {},
        lastUpdatedDates: {},
      },
      // The list carries no logs; the failed row reads its tail per job
      queue: {
        paused: false,
        total: 1,
        jobs: [
          {
            id: 'job-1',
            folderPath: '/videos/e2e',
            videoId: 'v1',
            videoUrl: 'https://yt/v1',
            title: 'Pierwszy film',
            type: 'download',
            status: 'error',
            error: 'yt-dlp exited with code 1 after 3 attempts',
            createdAt: '2026-01-01T10:00:00.000Z',
            finishedAt: '2026-01-01T10:01:00.000Z',
          },
        ],
      },
      queueJob: {
        job: {
          id: 'job-1',
          folderPath: '/videos/e2e',
          videoId: 'v1',
          videoUrl: 'https://yt/v1',
          title: 'Pierwszy film',
          type: 'download',
          status: 'error',
          error: 'yt-dlp exited with code 1 after 3 attempts',
          log,
          logLineCount: log.length,
          createdAt: '2026-01-01T10:00:00.000Z',
          finishedAt: '2026-01-01T10:01:00.000Z',
        },
      },
    });
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto('/download');
    await expandChannel(page);
    await page.getByText(log[19] ?? '').waitFor();

    const rows = page.locator('.video-item');
    const first = await rows.nth(0).boundingBox();
    const second = await rows.nth(1).boundingBox();
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    const overlap = (second?.y ?? 0) - ((first?.y ?? 0) + (first?.height ?? 0));
    expect(overlap).toBeGreaterThanOrEqual(-1);
  });
});
