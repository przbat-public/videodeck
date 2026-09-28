import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { LibraryEvent } from '@videodeck/shared/api';
import { beforeEach, describe, expect, it } from 'vitest';
import i18n from '../i18n';
import { installFetchMock, jsonResponse } from '../test/fetchMock';
import { resetElasticsearchState, setElasticsearchState } from '../utils/elasticsearchStatus';
import { applyLibraryFrame } from '../utils/libraryStatus';
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

describe('LibraryNotice', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    resetElasticsearchState();
  });

  it('says how many channels arrived and offers one reindex', () => {
    render(<LibraryNotice />);

    act(() => {
      applyLibraryFrame(frame({ added: ['/videos/a', '/videos/b'] }));
    });

    const notice = screen.getByRole('status');
    expect(notice).toHaveTextContent(i18n.t('library.detected', { count: 2 }));
    // The count itself: a missing catalog key would render the raw key and
    // still match the assertion above, which is what this line rules out
    expect(notice).toHaveTextContent('2');
    expect(reindexButton()).toBeEnabled();
  });

  it('says nothing for an opening frame', () => {
    render(<LibraryNotice />);

    act(() => {
      applyLibraryFrame(frame());
    });

    expect(screen.queryByRole('status')).toBeNull();
  });

  it('indexes the new folders with onlyMissing when the action runs', async () => {
    mockReindexServer();
    const user = userEvent.setup();
    render(<LibraryNotice />);
    act(() => {
      applyLibraryFrame(frame({ added: ['/videos/a'] }));
    });

    await user.click(reindexButton());

    await waitFor(() => {
      expect(fetchMock.mock.calls.map(([url]) => url)).toContain('/api/videos/refreshCache?onlyMissing=1');
    });
  });

  it('clears once the action is taken and comes back for the next arrival', async () => {
    mockReindexServer();
    const user = userEvent.setup();
    render(<LibraryNotice />);
    act(() => {
      applyLibraryFrame(frame({ added: ['/videos/a'] }));
    });

    await user.click(reindexButton());
    await waitFor(() => {
      expect(screen.queryByRole('status')).toBeNull();
    });

    // A second drive arrives while the first run is under way
    act(() => {
      applyLibraryFrame(frame({ revision: 3, folders: ['/videos/a', '/videos/b', '/videos/c'], added: ['/videos/c'] }));
    });

    const notice = screen.getByRole('status');
    expect(notice).toHaveTextContent(i18n.t('library.detected', { count: 1 }));
    expect(notice).toHaveTextContent('1');
  });

  it('is dismissed without indexing anything', async () => {
    const user = userEvent.setup();
    render(<LibraryNotice />);
    act(() => {
      applyLibraryFrame(frame({ added: ['/videos/a'] }));
    });

    await user.click(screen.getByRole('button', { name: i18n.t('library.dismiss') }));

    expect(screen.queryByRole('status')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('disables the action with the reason while Elasticsearch is down', async () => {
    setElasticsearchState('down');
    const user = userEvent.setup();
    render(<LibraryNotice />);
    act(() => {
      applyLibraryFrame(frame({ added: ['/videos/a'] }));
    });

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
    act(() => {
      applyLibraryFrame(frame({ added: ['/videos/a'] }));
    });

    await user.click(reindexButton());
    act(() => {
      applyLibraryFrame(frame({ revision: 3, folders: ['/videos/a', '/videos/c'], added: ['/videos/c'] }));
    });

    expect(reindexButton()).toBeDisabled();
  });
});
