import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockResponse } from '../test/fetchMock';
import { installFetchMock } from '../test/fetchMock';
import { FolderSection } from './FolderSection';

const fetchMock = installFetchMock();

const json = (body: unknown, status = 200): MockResponse => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const listResponse = {
  videos: [{ id: 'v1', title: 'Pierwszy film', url: 'https://yt/v1' }],
  downloadStatuses: {},
  lastUpdatedDates: {},
};

/** The folder queue poll the video list runs next to its own fetch */
const queueResponse = { jobs: [], total: 0, paused: false };

const renderSection = (props: Partial<Parameters<typeof FolderSection>[0]> = {}) =>
  render(
    <MemoryRouter>
      <FolderSection
        folderPath="/videos/a"
        initialConfig={{ channelUrl: 'https://www.youtube.com/@a' }}
        initialListExists={true}
        {...props}
      />
    </MemoryRouter>,
  );

describe('FolderSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string) =>
      url.startsWith('/api/folder/list?') ? json(listResponse) : json(queueResponse),
    );
  });

  it('renders the sections without a header or a card of its own', async () => {
    renderSection();

    // Let the section's own list load first: an unawaited fetch resolves
    // after the test ends and React reports it outside act
    await screen.findByText('Pierwszy film');

    // The channel row above already names the channel and shows the index
    // warning, so a second heading in here would only repeat it
    expect(screen.queryByRole('heading', { name: '/videos/a' })).toBeNull();
    expect(screen.queryByText('/videos/a')).toBeNull();
  });

  it('loads the channel videos as soon as the section opens', async () => {
    renderSection();

    // The row's own toggle is the whole gesture: no playlist button and no
    // "load the list" button stands between the channel and its videos
    expect(await screen.findByText('Pierwszy film')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/folder/list?folderPath=%2Fvideos%2Fa');
  });

  it('has no playlist actions of its own', async () => {
    renderSection();

    await screen.findByText('Pierwszy film');
    // Fetching and updating the playlist lives in the row's ⋯ menu now
    expect(screen.queryByRole('button', { name: /playlistę/ })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining('/api/folder/list-exists'));
  });

  it('shows no videos for a channel whose list.json is not there', () => {
    const { container } = renderSection({ initialListExists: false });

    expect(screen.queryByText('Pierwszy film')).toBeNull();
    expect(container.querySelector('.videos-list')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lists a collection right away, with no playlist step in front of it', async () => {
    renderSection({
      folderPath: '/videos/youtube',
      initialConfig: { kind: 'collection' },
      initialListExists: false,
    });

    // Single downloads have no playlist behind them: the section goes
    // straight to the videos the folder holds
    expect(await screen.findByText('Pierwszy film')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/folder/list?folderPath=%2Fvideos%2Fyoutube');
    expect(screen.queryByRole('button', { name: /playlist/i })).toBeNull();
  });

  it('says a folder has no config.json instead of showing a form in the sheet', async () => {
    renderSection({ initialConfig: null });

    await screen.findByText('Pierwszy film');

    // The missing file is information, not a form: editing lives in the row
    // menu's dialog, so the sheet only says what is not there
    expect(screen.getByText('Plik config.json nie istnieje w tym folderze.')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByLabelText('Adres kanału YouTube:')).toBeNull();
  });
});
