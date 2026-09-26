import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import i18n from '../../i18n';
import { tabTo, typeAndCommitPhrase } from './drivers/searchDrivers';
import type { RenderedApp } from './render-app';
import { refreshCacheAndWait, renderApp } from './render-app';
import { startBackend, stopBackend } from './test-env';

/**
 * Journey D: settings and keyboard. The theme and language choices persist
 * through navigation, and the whole search can be driven without a mouse.
 */

beforeAll(async () => {
  await startBackend();
  await refreshCacheAndWait();
});

afterAll(async () => {
  await stopBackend();
});

afterEach(() => {
  cleanup();
});

/** Opens the gear menu and picks one item by its visible label */
async function pickMenuItem(user: RenderedApp['user'], label: string): Promise<void> {
  // The top bar sits inside the lazy router tree, so the trigger appears
  // once the first chunk resolves; findByRole waits for it.
  await user.click(await screen.findByRole('button', { name: /Menu aplikacji|App menu/ }));
  await user.click(await screen.findByRole('menuitem', { name: label }));
}

describe('settings journey — theme and language survive navigation', () => {
  it('keeps English and dark mode across a detail visit and back', async () => {
    const page = await renderApp('/');

    // Switch the UI to English, then the theme to dark, both in the menu.
    await pickMenuItem(page.user, 'English');
    await screen.findByLabelText('Search phrase');
    await pickMenuItem(page.user, 'Dark');
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('dark'));

    // Search, open a video and come back through the top bar back link.
    await typeAndCommitPhrase(page.user, 'kosmos', 'Search phrase');
    await screen.findByText((_content, element) => element?.textContent === 'Historia kosmosu');
    await page.user.click(screen.getByRole('link', { name: /Historia kosmosu/ }));
    // The detail page is entered through its own route signal: the URL, the
    // English back link and the gone search form. The card's <h3> carries the
    // same title on the list, so a heading wait here would pass without any
    // navigation.
    await waitFor(
      () => {
        expect(page.router.state.location.pathname).toBe('/video/deepE2e0002');
        expect(screen.getByRole('link', { name: /Back to list/ })).toBeInTheDocument();
        expect(screen.queryByLabelText('Search phrase')).toBeNull();
      },
      { timeout: 15_000 },
    );
    await screen.findByText(i18n.t('video.description'));

    // Both choices persisted across the in-place navigation.
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.lang).toBe('en');

    await page.user.click(screen.getByRole('link', { name: /Back to list/ }));
    await screen.findByLabelText('Search phrase');
    expect(document.documentElement.dataset.theme).toBe('dark');

    // And back to Polish.
    await pickMenuItem(page.user, 'Polski');
    await screen.findByLabelText('Fraza wyszukiwania');
  });

  it('reaches every search control by Tab and picks a sort with arrow keys alone', async () => {
    const page = await renderApp('/');
    await pickMenuItem(page.user, 'Polski');
    await screen.findByLabelText('Fraza wyszukiwania');

    // The Tab order from the top bar down to the controls is the keyboard
    // path; typed phrases and their results live in the search journey.
    const input = await tabTo(page.user, 'Fraza wyszukiwania');
    expect(input).toBe(document.activeElement);

    // Continue tabbing to the sort select, open it and pick views-desc
    // with the arrow keys alone.
    await tabTo(page.user, 'Sort');
    await page.user.keyboard('{Enter}');
    await page.user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}{Enter}');
    await waitFor(() => {
      expect(document.activeElement?.getAttribute('aria-label')).toBe('Sort');
    });
  });
});
