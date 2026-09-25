import { existsSync } from 'node:fs';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import type { DeepServerTestEnv } from '@videodeck/test-infra/deepServerTestEnv';
import { folderConfig } from '@videodeck/test-infra/deepServerTestEnv';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { channelRow, folderSection } from './drivers/statusDrivers';
import type { RenderedApp } from './render-app';
import { renderApp } from './render-app';
import { startBackend, stopBackend } from './test-env';

// polish-ok: the journey drives the console through its real labels.
/**
 * Journey E: the yt-dlp hardening, walked through the UI the way an operator
 * would. The channel folder carries a planted `yt-dlp.conf`, and the config
 * form is used to try to smuggle an escaping argument in. The real backend has
 * to refuse the argument and ignore the config file, with the fake yt-dlp
 * standing at the process boundary as the witness.
 */

let env: DeepServerTestEnv;
let folderPath: string;

/** The file the planted config would create if yt-dlp ever loaded it */
const PWNED_MARKER = 'pwned-from-conf';

beforeAll(async () => {
  env = await startBackend();
  folderPath = await env.seedFolder('channel-hardening', {
    'config.json': folderConfig('https://www.youtube.com/@hardening'),
    // The second RCE path from the review: yt-dlp reads yt-dlp.conf from its
    // working directory, and this one is the channel folder.
    'yt-dlp.conf': `--exec 'touch ${PWNED_MARKER}'\n`,
  });
  env.setFolders('channel-integration', 'channel-two', 'channel-hardening');
});

afterAll(async () => {
  await stopBackend();
});

afterEach(() => {
  cleanup();
});

async function openConfigEditor(folder: string): Promise<{ page: RenderedApp; field: HTMLElement }> {
  const page = await renderApp('/download');
  const row = await channelRow(folder);
  await page.user.click(within(row).getByRole('button', { name: 'Więcej akcji' }));
  await page.user.click(await screen.findByRole('menuitem', { name: 'Edytuj config.json' }));
  return { page, field: await screen.findByLabelText('Dodatkowe argumenty yt-dlp:') };
}

describe('yt-dlp hardening journey — the console cannot reach a command', () => {
  it('refuses an escaping extraArgs list in the editor, then saves the throttling one', async () => {
    const { page, field } = await openConfigEditor(folderPath);

    await page.user.clear(field);
    await page.user.type(field, '--alias foo "--exec {0}" --foo "touch pwned"');
    await page.user.click(screen.getByRole('button', { name: 'Zapisz' }));

    // The server's refusal reaches the form (the Polish catalog wraps it)
    await screen.findByText(/Błąd: extraArgs uses an argument that is not allowed: --alias/);

    // The same form takes an allowlisted flag, and the editor closes on save
    await page.user.clear(field);
    await page.user.type(field, '--sleep-requests 1');
    await page.user.click(screen.getByRole('button', { name: 'Zapisz' }));
    await waitFor(() => {
      expect(screen.queryByLabelText('Dodatkowe argumenty yt-dlp:')).toBeNull();
    });
  });

  it('pulls the channel playlist from a folder with a planted yt-dlp.conf', async () => {
    const page = await renderApp('/download');
    const section = await folderSection(folderPath);

    await page.user.click(within(section).getByRole('button', { name: 'Pobierz playlistę' }));
    await within(section).findByText(/Plik list\.json już istnieje/);
    await page.user.click(within(section).getByRole('button', { name: 'Pobierz listę filmów' }));
    await within(section).findByText('Fake playlist video 1');

    // The fake refuses to run when a config file would have been loaded, so
    // reaching this point proves the backend passed --ignore-config. The
    // planted --exec never ran either.
    expect(existsSync(`${folderPath}/${PWNED_MARKER}`)).toBe(false);
  }, 30_000);
});
