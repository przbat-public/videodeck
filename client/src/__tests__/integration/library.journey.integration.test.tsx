import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import type { DeepServerTestEnv } from '@videodeck/test-infra/deepServerTestEnv';
import { folderConfig, videoFiles } from '@videodeck/test-infra/deepServerTestEnv';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import i18n from '../../i18n';
import { getLibraryRevision } from '../../utils/libraryStatus';
import { renderApp } from './render-app';
import { startBackend, stopBackend } from './test-env';

/**
 * Journey: a drive that arrives while a page is open reaches that page
 * without a reload.
 *
 * This is the acceptance test for the whole feature, so nothing on the way is
 * faked: the real <App /> at /download, the real backend in-process, the real
 * watcher on the seeded library and the real `GET /api/events` stream. Only
 * the drive is simulated, by writing a channel folder where the watcher looks.
 */

let env: DeepServerTestEnv;

/**
 * How long a filesystem event may take to reach the rendered row: the watcher
 * debounces, the server reconciles, the client re-reads over HTTP and React
 * renders. Generous on purpose, because the assertion is the row, not the
 * duration, and a busy CI machine is not a failure.
 */
const LIBRARY_CHANGE_TIMEOUT_MS = 20_000;

/** The alias the server derives from a folder path (elasticsearchService) */
const folderAlias = (folderPath: string): string =>
  `videos_${createHash('sha256').update(folderPath).digest('hex').substring(0, 16)}`;

beforeAll(async () => {
  env = await startBackend();
});

afterAll(async () => {
  await stopBackend();
});

afterEach(() => {
  cleanup();
});

describe('a drive that arrives while the console is open', () => {
  it('adds its channel to the console without a reload', async () => {
    // From here on the library is every folder under videos/, so the folder
    // created below is a drive arriving rather than a stray directory
    env.watchVideosDir();
    await renderApp('/download');

    // The seeded channels are on screen before anything moves, which is also
    // the proof that the page rendered its first answer and not a later one
    await screen.findByText('channel-integration', undefined, { timeout: LIBRARY_CHANGE_TIMEOUT_MS });
    expect(screen.queryByText('channel-hotplug')).toBeNull();
    const revisionBefore = getLibraryRevision();

    // The drive arrives. The write sits in its own act window because the
    // stream can move the store while it is in flight, and the rest of the
    // reaction below is awaited through waitFor, which owns updates it covers.
    await act(async () => {
      await env.seedFolder('channel-hotplug', {
        ...videoFiles('hotplug0001', 'Wideo z nowego dysku'),
        'config.json': folderConfig('https://www.youtube.com/@hotplug'),
      });
    });

    // No reload and no navigation: the frame moves the revision, the console
    // re-reads the status and the new row appears
    await waitFor(
      () => {
        expect(getLibraryRevision()).toBeGreaterThan(revisionBefore);
        expect(screen.getByText('channel-hotplug')).toBeInTheDocument();
      },
      { timeout: LIBRARY_CHANGE_TIMEOUT_MS },
    );

    expect(screen.getByText('channel-integration')).toBeInTheDocument();
  });

  it('offers one reindex for the channel that just arrived, and indexes nothing before the click', async () => {
    env.watchVideosDir();
    const { user } = await renderApp('/download');

    await screen.findByText('channel-integration', undefined, { timeout: LIBRARY_CHANGE_TIMEOUT_MS });

    await act(async () => {
      await env.seedFolder('channel-newdrive', {
        ...videoFiles('newdrive0001', 'Film z nowego dysku'),
        'config.json': folderConfig('https://www.youtube.com/@newdrive'),
      });
    });

    // The arrival is announced with its count, and the one action that can
    // index it sits in the same strip
    const notice = await screen.findByText(i18n.t('library.detected', { count: 1 }), undefined, {
      timeout: LIBRARY_CHANGE_TIMEOUT_MS,
    });
    const alias = folderAlias(env.folder('channel-newdrive'));

    // Detection is not indexing: nothing wrote a cache for that folder yet,
    // and search would find none of its videos
    expect(env.fakeEs.aliasOf(alias)).toBeUndefined();

    await user.click(screen.getByRole('button', { name: i18n.t('library.reindexNew') }));

    // The click is what starts the disk work, and the notice stands down for
    // the reindex toasts to take over
    await waitFor(() => expect(env.fakeEs.aliasOf(alias)).toBeDefined(), { timeout: LIBRARY_CHANGE_TIMEOUT_MS });
    expect(notice).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: i18n.t('library.reindexNew') })).toBeNull();
  });
});

describe('a drive that leaves while the console is open', () => {
  it('keeps its channel on screen as unplugged', async () => {
    env.watchVideosDir();
    await renderApp('/download');

    await screen.findByText('channel-two', undefined, { timeout: LIBRARY_CHANGE_TIMEOUT_MS });
    const revisionBefore = getLibraryRevision();

    // The drive goes away: the folder leaves the watched root in one rename,
    // the way a volume disappears, so the reconciling scan reports it as
    // unavailable instead of forgetting it. A recursive delete would race the
    // app writing its folder index in there.
    await act(async () => {
      await fs.rename(env.folder('channel-two'), path.join(env.root, 'channel-two-gone'));
    });

    /** The row of the channel that left, as the table renders it right now */
    const channelRow = (): HTMLElement | null => screen.getByText('channel-two').closest('tr');

    await waitFor(
      () => {
        expect(getLibraryRevision()).toBeGreaterThan(revisionBefore);
        // Waiting on that one row and not on a bare chip: the library also
        // reports paths that were configured earlier and are gone, so a chip
        // anywhere on the page would pass without this channel moving
        expect(within(channelRow() as HTMLElement).getByText('dysk odłączony')).toBeInTheDocument();
      },
      { timeout: LIBRARY_CHANGE_TIMEOUT_MS },
    );

    // The row kept its name and its place, and no reload happened: the channel
    // that never moved is still rendered by the same page
    const row = channelRow();
    expect(row).not.toBeNull();
    expect(screen.getByText('channel-integration')).toBeInTheDocument();
    // Nothing behind that row can work while the drive is away
    expect(within(row as HTMLElement).getByRole('button', { name: 'Pokaż filmy' })).toBeDisabled();
    expect(within(row as HTMLElement).getByRole('button', { name: 'Więcej akcji' })).toBeDisabled();
  });
});
