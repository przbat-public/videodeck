import { render, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router-dom';
import App from '../../App';
import { routes } from '../../routes';

export interface RenderedApp {
  user: ReturnType<typeof userEvent.setup>;
  unmount: () => void;
  /** The memory router, for asserting URL state in journeys */
  router: ReturnType<typeof createMemoryRouter>;
}

/**
 * Renders the REAL <App /> (real hooks, real router, real pages) against
 * the real backend booted by the integration global setup. The only seam is
 * the fetch proxy in setup.ts. Use it like the vita-tracker renderApp.
 */
export async function renderApp(route: string): Promise<RenderedApp> {
  const router = createMemoryRouter(routes, { initialEntries: [route] });
  const user = userEvent.setup();
  const view = render(<App router={router} />);
  return { user, unmount: view.unmount, router };
}

/** Drive the real reindex through the API and wait until it is idle */
export async function refreshCacheAndWait(): Promise<void> {
  const response = await fetch('/api/videos/refreshCache', { method: 'POST' });
  if (!response.ok) {
    throw new Error(`refreshCache failed: ${response.status}`);
  }
  await waitFor(
    async () => {
      const statusResponse = await fetch('/api/videos/refreshCache/status');
      const status = (await statusResponse.json()) as { running: boolean };
      expect(status.running).toBe(false);
    },
    { timeout: 30_000, interval: 250 },
  );
}
