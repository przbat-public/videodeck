import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { LibraryEvent } from '@videodeck/shared/api';
import { beforeEach, describe, expect, it } from 'vitest';
import i18n from '../i18n';
import { installFetchMock, jsonResponse } from '../test/fetchMock';
import { resetElasticsearchState, setElasticsearchState } from '../utils/elasticsearchStatus';
import { applyLibraryFrame, resetLibraryState } from '../utils/libraryStatus';
import { LibraryNotice } from './LibraryNotice';

const fetchMock = installFetchMock();

/** A frame of GET /api/events; the opening one carries no `added` */
const frame = (overrides: Partial<LibraryEvent> = {}): LibraryEvent => ({
  type: 'library',
  revision: 2,
  folders: ['/videos/a', '/videos/b'],
  unavailable: [],
  ...overrides,
});

/**
 * A drive arriving the way the stream reports it: one frame describes the
 * library as it was, the next one describes it with `arrived` in it. The store
 * computes the change from the two lists, so a single frame would look like
 * the opening snapshot of a page load and rightly raise nothing.
 */
function arrive(before: string[], arrived: string[], revision = 2): void {
  act(() => {
    applyLibraryFrame(frame({ revision: revision - 1, folders: before }));
    applyLibraryFrame(frame({ revision, folders: [...before, ...arrived] }));
  });
}

/** GET /api/videos/refreshCache/status once the run is over */
const finishedRun = {
  running: false,
  foldersDone: 1,
  foldersTotal: 1,
  filesDone: 1,
  filesTotal: 1,
  indexed: 1,
  skipped: 0,
  errors: [],
};

/** The two endpoints the action talks to; anything else is a bug in the flow */
function mockReindexServer(): void {
  fetchMock.mockImplementation(async (url: string) => {
    if (url === '/api/videos/refreshCache?onlyMissing=1') {
      return jsonResponse({ status: 'ok', message: 'Cache refresh process started' });
    }
    if (url === '/api/videos/refreshCache/status') {
      return jsonResponse(finishedRun);
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

const reindexButton = (): HTMLElement => screen.getByRole('button', { name: i18n.t('library.reindexNew') });

/** Whether the strip is on screen: its action is the part nobody can miss */
const noticeIsGone = (): boolean => screen.queryByRole('button', { name: i18n.t('library.reindexNew') }) === null;

describe('LibraryNotice', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    resetElasticsearchState();
    resetLibraryState();
  });

  it('says how many channels arrived and offers one reindex', () => {
    render(<LibraryNotice />);

    arrive(['/videos/a'], ['/videos/b', '/videos/c']);

    const text = screen.getByText(i18n.t('library.detected', { count: 2 }));
    // The count itself: a missing catalog key would render the raw key and
    // still match the assertion above, which is what this line rules out
    expect(text).toHaveTextContent('2');
    expect(reindexButton()).toBeEnabled();
  });

  it('says nothing for an opening frame', () => {
    render(<LibraryNotice />);

    act(() => {
      applyLibraryFrame(frame());
    });

    expect(noticeIsGone()).toBe(true);
  });

  it('indexes the new folders with onlyMissing when the action runs', async () => {
    mockReindexServer();
    const user = userEvent.setup();
    render(<LibraryNotice />);
    arrive(['/videos/a'], ['/videos/b']);

    await user.click(reindexButton());

    await waitFor(() => {
      expect(fetchMock.mock.calls.map(([url]) => url)).toContain('/api/videos/refreshCache?onlyMissing=1');
    });
  });

  it('clears once the action is taken and comes back for the next arrival', async () => {
    mockReindexServer();
    const user = userEvent.setup();
    render(<LibraryNotice />);
    arrive(['/videos/a'], ['/videos/b'], 2);

    await user.click(reindexButton());
    await waitFor(() => {
      expect(noticeIsGone()).toBe(true);
    });

    // A second drive arrives while the first run is under way
    arrive(['/videos/a', '/videos/b'], ['/videos/c'], 3);

    expect(screen.getByText(i18n.t('library.detected', { count: 1 }))).toHaveTextContent('1');
  });

  it('is dismissed without indexing anything', async () => {
    const user = userEvent.setup();
    render(<LibraryNotice />);
    arrive(['/videos/a'], ['/videos/b']);

    await user.click(screen.getByRole('button', { name: i18n.t('library.dismiss') }));

    expect(noticeIsGone()).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('disables the action with the reason while Elasticsearch is down', async () => {
    setElasticsearchState('down');
    const user = userEvent.setup();
    render(<LibraryNotice />);
    arrive(['/videos/a'], ['/videos/b']);

    expect(reindexButton()).toBeDisabled();

    // The reason reaches a keyboard user through the shared tooltip, not a
    // native title attribute
    await user.tab();
    expect(await screen.findByRole('tooltip', { name: i18n.t('library.reindexOffline') })).toBeInTheDocument();
  });

  it('keeps the next arrival disabled while a run is starting', async () => {
    // The start request never settles, which is the window between the click
    // and the server's answer: `loading` is true for its whole duration
    fetchMock.mockImplementation(async () => await new Promise<never>(() => undefined));
    const user = userEvent.setup();
    render(<LibraryNotice />);
    arrive(['/videos/a'], ['/videos/b'], 2);

    await user.click(reindexButton());
    arrive(['/videos/a', '/videos/b'], ['/videos/c'], 3);

    expect(reindexButton()).toBeDisabled();
  });
});
