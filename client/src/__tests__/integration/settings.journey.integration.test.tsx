import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
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

    // Search, open a video and come back through the back link. Cards open
    // in a new tab (target=_blank), so the journey renders the route that
    // new tab would load.
    await typeAndCommitPhrase(page.user, 'kosmos', 'Search phrase');
    await screen.findByText((_content, element) => element?.textContent === 'Historia kosmosu');
    await page.user.click(screen.getByRole('link', { name: /Historia kosmosu/ }));
    page.unmount();
    const detail = await renderApp('/video/deepE2e0002');
    await screen.findByRole('heading', { name: 'Historia kosmosu' });
    await screen.findByText('Original description');

    // Both choices persisted into the new tab.
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.lang).toBe('en');

    await detail.user.click(screen.getByRole('link', { name: /Back to search/ }));
    await screen.findByLabelText('Search phrase');
    expect(document.documentElement.dataset.theme).toBe('dark');

    // And back to Polish.
    await pickMenuItem(detail.user, 'Polski');
    await screen.findByLabelText('Fraza wyszukiwania');
  });

  it('runs a full search by keyboard alone', async () => {
    const page = await renderApp('/');
    await pickMenuItem(page.user, 'Polski');
    await screen.findByLabelText('Fraza wyszukiwania');

    // Tab from the top bar to the query input. jsdom implements no text
    // insertion for raw keyboard events, so the phrase goes through
    // user.type (the same events a real browser synthesizes); navigation,
    // Enter and the arrows below stay real keyboard events.
    const input = await tabTo(page.user, 'Fraza wyszukiwania');
    expect(input).toBe(document.activeElement);
    await page.user.type(input, 'kosmos');
    await page.user.keyboard('{Enter}');
    await waitFor(() => expect(screen.queryByText('Głęboka integracja')).not.toBeInTheDocument());
    await screen.findByText((_content, element) => element?.textContent === 'Historia kosmosu');

    // Continue tabbing to the sort select, open it and pick views-desc
    // with the arrow keys alone.
    await tabTo(page.user, 'Sort');
    await page.user.keyboard('{Enter}');
    await page.user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}{Enter}');
    await waitFor(() => {
      expect(document.activeElement?.getAttribute('aria-label')).toBe('Sort');
    });
    await screen.findByText((_content, element) => element?.textContent === 'Historia kosmosu');
  });
});
