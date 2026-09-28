import { act, cleanup, screen, waitFor } from '@testing-library/react';
import type { DeepServerTestEnv } from '@videodeck/test-infra/deepServerTestEnv';
import { folderConfig, videoFiles } from '@videodeck/test-infra/deepServerTestEnv';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
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
});
