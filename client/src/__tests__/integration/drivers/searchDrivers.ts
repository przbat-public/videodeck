import { fireEvent, screen } from '@testing-library/react';
import type { RenderedApp } from '../render-app';

// polish-ok: the drivers address the real controls by their default-locale
// labels, exactly like the journey tests do.
/**
 * Typed UI drivers for the full-stack journeys. They wrap userEvent and
 * the testing-library queries so a journey reads as the user's actions,
 * not as a sequence of DOM lookups. Labels are the Polish catalog values
 * (the default locale), asserted the same way the rest of the suite does.
 */

export const findSearchInput = () => screen.findByLabelText('Fraza wyszukiwania');

export const sortSelect = () => screen.getByLabelText('Sort');
export const categorySelect = () => screen.getByLabelText('Kategoria');
export const channelSelect = () => screen.findByRole('combobox', { name: 'Kanał' });
export const fromDateInput = () => screen.getByLabelText('Od daty');
export const toDateInput = () => screen.getByLabelText('Do daty');

/** Type a phrase and commit it with Enter (the debounce does not wait) */
export async function typeAndCommitPhrase(
  user: RenderedApp['user'],
  phrase: string,
  inputLabel = 'Fraza wyszukiwania',
): Promise<void> {
  const input = await screen.findByLabelText(inputLabel);
  await user.type(input, phrase);
  fireEvent.keyDown(input, { key: 'Enter' });
}

/** Enter text into a labelled input and let its own debounce commit it */
export async function typeInto(user: RenderedApp['user'], label: string, value: string): Promise<void> {
  const input = screen.getByLabelText(label);
  await user.type(input, value);
}

/**
 * Card titles get split into a <mark> plus plain text when the phrase
 * highlights them, so a plain getByText misses them. This matcher compares
 * the element's full textContent instead.
 */
const titleMatcher = (title: string) => (_content: string, element: Element | null) => element?.textContent === title;

/** Wait for a video card with exactly this title */
export const findCardByTitle = (title: string) => screen.findByText(titleMatcher(title));

/** The card with exactly this title, or null */
export const queryCardByTitle = (title: string) => screen.queryByText(titleMatcher(title));

/** Pick an option in one of the Radix selects, by its visible label */
export async function pickOption(
  user: RenderedApp['user'],
  trigger: ReturnType<typeof screen.getByLabelText>,
  optionLabel: string,
): Promise<void> {
  await user.click(trigger);
  await user.click(screen.getByRole('option', { name: optionLabel }));
}

/** The visible cards' titles, in render order */
export const visibleTitles = () =>
  screen
    .queryAllByRole('link')
    .map((link) => link.textContent ?? '')
    .filter((text) => text.length > 0);

/**
 * Press Tab until an element with the given accessible name is focused.
 * Bounded so a reordered toolbar fails loudly instead of hanging.
 */
export async function tabTo(user: RenderedApp['user'], name: string, maxTabs = 30): Promise<HTMLElement> {
  for (let i = 0; i < maxTabs; i += 1) {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.getAttribute('aria-label') === name) {
      return active;
    }
    await user.tab();
  }
  throw new Error(`did not reach an element named "${name}" within ${maxTabs} Tab presses`);
}
