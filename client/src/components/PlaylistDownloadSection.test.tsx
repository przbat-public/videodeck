import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockResponse } from '../test/fetchMock';
import { installFetchMock } from '../test/fetchMock';
import { PlaylistDownloadSection } from './PlaylistDownloadSection';

const fetchMock = installFetchMock();

const json = (body: unknown, status = 200): MockResponse => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const config = { channelUrl: 'https://www.youtube.com/@kanal' };

const renderSection = (overrides: Partial<Parameters<typeof PlaylistDownloadSection>[0]> = {}) => {
  const props = {
    folderPath: '/videos/kanal',
    config,
    listExists: true,
    onPlaylistDownloaded: vi.fn(),
    ...overrides,
  };
  render(<PlaylistDownloadSection {...props} />);
  return props;
};

describe('PlaylistDownloadSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockReset();
  });

  it('renders nothing for a folder without a channel URL', () => {
    const { container } = render(
      <PlaylistDownloadSection
        folderPath="/videos/kanal"
        config={null}
        listExists={null}
        onPlaylistDownloaded={vi.fn()}
      />,
    );

    expect(container.innerHTML).toBe('');
  });

  it('describes the state of list.json', () => {
    renderSection({ listExists: null });
    expect(screen.getByText('Sprawdzanie statusu pliku list.json...')).toBeInTheDocument();
  });

  it('offers to update an existing list.json', () => {
    renderSection({ listExists: true });

    expect(screen.getByText(/Plik list\.json już istnieje/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Aktualizuj playlistę' })).toBeInTheDocument();
  });

  it('offers to create a missing list.json', () => {
    renderSection({ listExists: false });

    expect(screen.getByText(/Plik list\.json nie istnieje/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pobierz playlistę' })).toBeInTheDocument();
  });

  it('downloads the playlist and tells the parent', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(json({ message: 'ok' }, 202));
    const props = renderSection({ listExists: false });

    await user.click(screen.getByRole('button', { name: 'Pobierz playlistę' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith('/api/folder/download-playlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderPath: '/videos/kanal' }),
    });
    await waitFor(() => expect(props.onPlaylistDownloaded).toHaveBeenCalled());
  });

  it('shows the message the server sent with a failed request', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(json({ error: 'boom', message: 'Kanał nie istnieje' }, 500));
    renderSection();

    await user.click(screen.getByRole('button', { name: 'Aktualizuj playlistę' }));

    expect(await screen.findByText('Błąd: Kanał nie istnieje')).toBeInTheDocument();
  });

  it('falls back to its own message when the failure carries no body', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue({ ok: false, status: 502, json: async () => null });
    renderSection();

    await user.click(screen.getByRole('button', { name: 'Aktualizuj playlistę' }));

    expect(await screen.findByText('Błąd: Failed to download playlist')).toBeInTheDocument();
  });

  it('reports a network failure that is not an Error', async () => {
    const user = userEvent.setup();
    fetchMock.mockRejectedValue('boom');
    renderSection();

    await user.click(screen.getByRole('button', { name: 'Aktualizuj playlistę' }));

    expect(await screen.findByText('Błąd: An error occurred')).toBeInTheDocument();
  });
});
