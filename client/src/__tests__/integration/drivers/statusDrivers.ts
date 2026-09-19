import { fireEvent, screen, within } from '@testing-library/react';

// polish-ok: the driver addresses the console rows and the folder section by
// their real labels (the folder path and the Polish catalog values).

/**
 * Typed UI drivers for the status-page journeys (playlist download and the
 * queue). The console keeps every folder section behind its channel row, so
 * the driver expands that row before handing the section back.
 */

/** Budget for a wait that covers a real request round trip against the backend */
const ROUND_TRIP_MS = 15_000;

/** The console row of a channel */
async function channelRow(folderPath: string): Promise<HTMLElement> {
  const path = await screen.findByText(folderPath, undefined, { timeout: ROUND_TRIP_MS });
  const row = path.closest('tr');
  if (!(row instanceof HTMLElement)) {
    throw new Error(`no channel row found for ${folderPath}`);
  }
  return row;
}

/** The folder section element; its heading shows the folder path */
export async function folderSection(folderPath: string): Promise<HTMLElement> {
  const row = await channelRow(folderPath);
  if (row.nextElementSibling?.querySelector('.folder-section') == null) {
    fireEvent.click(within(row).getByRole('button', { name: 'Pokaż filmy' }));
  }
  const heading = await screen.findByRole('heading', { name: folderPath }, { timeout: ROUND_TRIP_MS });
  const section = heading.closest('.folder-section');
  if (!(section instanceof HTMLElement)) {
    throw new Error(`no folder section found for ${folderPath}`);
  }
  return section;
}
