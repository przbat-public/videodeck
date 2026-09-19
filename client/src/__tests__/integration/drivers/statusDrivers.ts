import { fireEvent, screen, waitFor, within } from '@testing-library/react';

// polish-ok: the driver addresses the console rows and the folder section by
// their real labels (the folder path and the Polish catalog values).

/**
 * Typed UI drivers for the status-page journeys (playlist download and the
 * queue). The console keeps everything a channel owns behind its row, so the
 * driver expands that row before handing the section back.
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
 * The cell the expanded row adds underneath it: the config form, the playlist
 * actions and the video list. It carries no header of its own (the row above
 * names the channel), so the row it hangs from is the handle.
 */
export async function folderSection(folderPath: string): Promise<HTMLElement> {
  const row = await channelRow(folderPath);
  if (row.nextElementSibling?.querySelector('.channel-expanded-row') == null) {
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
