import { screen } from '@testing-library/react';

// polish-ok: the driver addresses the folder section by its real heading
// (the folder path), the same way the journey tests address the controls.
/**
 * Typed UI drivers for the status-page journeys (playlist download and the
 * queue). Labels are the Polish catalog values (the default locale).
 */

/** The folder section element; its heading shows the folder path */
export async function folderSection(folderPath: string): Promise<HTMLElement> {
  const heading = await screen.findByRole('heading', { name: folderPath });
  const section = heading.closest('.folder-section');
  if (!(section instanceof HTMLElement)) {
    throw new Error(`no folder section found for ${folderPath}`);
  }
  return section;
}
