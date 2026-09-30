import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { RenderedApp } from '../render-app';

// polish-ok: the driver addresses the console rows and the folder section by
// their real labels (the folder path and the Polish catalog values).

/**
 * Typed UI drivers for the status-page journeys (playlist download and the
 * queue). The console keeps everything a channel owns behind its row: the
 * driver fetches the playlist from the row menu and then opens the row, whose
 * videos load with it.
 */

/** Budget for a wait that covers a real request round trip against the backend */
const ROUND_TRIP_MS = 15_000;

/** The console row of a channel */
export async function channelRow(folderPath: string): Promise<HTMLElement> {
  const path = await screen.findByText(folderPath, undefined, { timeout: ROUND_TRIP_MS });
  const row = path.closest('tr');
  if (!(row instanceof HTMLElement)) {
    throw new Error(`no channel row found for ${folderPath}`);
  }
  return row;
}

/**
 * Run one of the channel's bulk actions from its row menu. The video list
 * carries per-video buttons only, so this is the way a journey queues work for
 * a whole channel. The menu opens on pointerdown, which is why this needs the
 * real userEvent.
 */
export async function runRowAction(user: RenderedApp['user'], folderPath: string, name: string): Promise<void> {
  const row = await channelRow(folderPath);
  await user.click(within(row).getByRole('button', { name: 'Więcej akcji' }));
  const entry = await screen.findByRole('menuitem', { name });
  // A disabled entry swallows the click without a word, and the journey that
  // clicked it would then fail somewhere else entirely. Radix marks one with
  // data-disabled rather than the disabled property.
  if (entry.getAttribute('data-disabled') !== null) {
    throw new Error(`the row menu entry "${name}" is disabled for ${folderPath}`);
  }
  await user.click(entry);
  // The menu closes on select; waiting for that keeps the next click off a
  // still-mounted overlay
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
}

/**
 * Fetch or update the channel's playlist from its row menu. The entry reads
 * "Pobierz playlistę" while list.json is missing and "Aktualizuj playlistę"
 * once it is there, so the driver matches the word the two share.
 */
export async function fetchPlaylist(user: RenderedApp['user'], folderPath: string): Promise<void> {
  const row = await channelRow(folderPath);
  await user.click(within(row).getByRole('button', { name: 'Więcej akcji' }));
  const entry = await screen.findByRole('menuitem', { name: /playlistę/ });
  await user.click(entry);
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
}

/**
 * The cell the expanded row adds underneath it: the config form and the video
 * list, which loads on its own. It carries no header of its own (the row above
 * names the channel), so the row it hangs from is the handle.
 *
 * A row opens only once the channel has a list.json, so a caller that just
 * fetched one waits here for the toggle to come back enabled.
 */
export async function folderSection(folderPath: string): Promise<HTMLElement> {
  const row = await channelRow(folderPath);
  if (row.nextElementSibling?.querySelector('.channel-expanded-row') == null) {
    await waitFor(() => expect(within(row).getByRole('button', { name: 'Pokaż filmy' })).toBeEnabled(), {
      timeout: ROUND_TRIP_MS,
    });
    fireEvent.click(within(row).getByRole('button', { name: 'Pokaż filmy' }));
  }
  return waitFor(() => {
    const cell = row.nextElementSibling?.querySelector('td');
    if (!(cell instanceof HTMLElement)) {
      throw new Error(`no expanded section for ${folderPath}`);
    }
    return cell;
  });
}
