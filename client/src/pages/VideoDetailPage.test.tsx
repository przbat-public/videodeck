import { render, screen } from '@testing-library/react';
import type { VideoDetails } from '@videodeck/shared/api';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FetchMock, MockResponse } from '../test/fetchMock';
import VideoDetailPage from './VideoDetailPage';

const details: VideoDetails = {
  title: 'A talk about hedgehogs',
  description: 'Everything about hedgehogs',
  uploadDate: '20240615',
  duration: '10:30',
  viewCount: 1234,
  likeCount: 56,
  channelName: 'Nature',
  comments: [],
  commentCount: 0,
  videoPath: 'hedgehogs.mp4',
  thumbnailPath: 'hedgehogs.webp',
  subtitles: [],
  folderPath: '/videos/a',
};

const json = (body: unknown, status = 200): MockResponse => ({
  ok: status < 400,
  status,
  json: async () => body,
});

function installFetch(handlers: { details?: () => MockResponse } = {}): FetchMock {
  const fetchMock: FetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/details')) {
      return handlers.details?.() ?? json({ details });
    }
    if (url.endsWith('/summary')) {
      return json({ summary: 'Hedgehogs are nocturnal.' });
    }
    throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/video/hedgehogs']}>
      <Routes>
        <Route path="/video/:videoId" element={<VideoDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );

describe('VideoDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installFetch();
  });

  it('shows a spinner while loading', () => {
    renderPage();

    expect(screen.getByText('Ładowanie filmu...')).toBeInTheDocument();
  });

  it('renders the title, metadata and description', async () => {
    renderPage();

    expect(await screen.findByText('A talk about hedgehogs')).toBeInTheDocument();
    // pl-PL does not group four-digit numbers
    expect(screen.getByText('1234 wyświetleń')).toBeInTheDocument();
    expect(screen.getByText('56 polubień')).toBeInTheDocument();
    expect(screen.getByText('2024-06-15')).toBeInTheDocument();
    expect(screen.getByText('Everything about hedgehogs')).toBeInTheDocument();
  });

  it('points the player at the file endpoint, folder included', async () => {
    renderPage();

    const player = await screen.findByTestId('video-player');
    expect(player).toHaveAttribute('src', `/api/videos/file/hedgehogs.mp4?folder=${encodeURIComponent('/videos/a')}`);
  });

  it('uses the downloaded thumbnail as the player poster', async () => {
    renderPage();

    const player = await screen.findByTestId('video-player');
    expect(player).toHaveAttribute(
      'poster',
      `/api/videos/file/hedgehogs.webp?folder=${encodeURIComponent('/videos/a')}`,
    );
  });

  it('renders one subtitle track per file with the language from its name', async () => {
    installFetch({
      details: () =>
        json({
          details: {
            ...details,
            subtitlePath: 'hedgehogs.en.vtt',
            subtitles: [
              { path: 'hedgehogs.en.vtt', lang: 'en' },
              { path: 'hedgehogs.pl.vtt', lang: 'pl' },
            ],
          },
        }),
    });
    renderPage();

    const player = await screen.findByTestId('video-player');
    const tracks = player.querySelectorAll('track');
    expect(tracks).toHaveLength(2);

    const [en, pl] = tracks;
    expect(en).toHaveAttribute('kind', 'subtitles');
    expect(en).toHaveAttribute('srcLang', 'en');
    expect(en).toHaveAttribute('label', 'Angielski');
    expect(en).toHaveAttribute('src', `/api/videos/file/hedgehogs.en.vtt?folder=${encodeURIComponent('/videos/a')}`);
    expect(en).toHaveAttribute('default');

    expect(pl).toHaveAttribute('srcLang', 'pl');
    expect(pl).toHaveAttribute('label', 'Polski');
    expect(pl).not.toHaveAttribute('default');
  });

  it('labels a subtitle file without a language code as generic', async () => {
    installFetch({
      details: () =>
        json({
          details: {
            ...details,
            subtitlePath: 'hedgehogs.vtt',
            subtitles: [{ path: 'hedgehogs.vtt' }],
          },
        }),
    });
    renderPage();

    const player = await screen.findByTestId('video-player');
    const track = player.querySelector('track');
    expect(track).not.toBeNull();
    expect(track).toHaveAttribute('srcLang', 'und');
    expect(track).toHaveAttribute('label', 'Napisy');
  });

  it('renders no subtitle track without subtitles', async () => {
    renderPage();

    const player = await screen.findByTestId('video-player');
    expect(player.querySelector('track')).toBeNull();
  });

  it('hides counters that are zero', async () => {
    installFetch({
      details: () => json({ details: { ...details, viewCount: 0, likeCount: 0 } }),
    });
    renderPage();

    await screen.findByText('A talk about hedgehogs');
    expect(screen.queryByText(/wyświetleń/)).toBeNull();
    expect(screen.queryByText(/polubień/)).toBeNull();
  });

  it('shows the summary once it arrives', async () => {
    installFetch({
      details: () => json({ details: { ...details, subtitlePath: 'hedgehogs.vtt' } }),
    });
    renderPage();

    expect(await screen.findByText('Hedgehogs are nocturnal.')).toBeInTheDocument();
  });

  it('offers to page through the comments when more are known', async () => {
    installFetch({
      details: () =>
        json({
          details: {
            ...details,
            comments: [{ id: 'c1', text: 'First' }],
            commentCount: 3,
          },
        }),
    });
    renderPage();

    expect(await screen.findByText('Komentarze (3)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pokaż więcej komentarzy (1/3)' })).toBeInTheDocument();
  });

  it('shows an error with a way back when the request fails', async () => {
    installFetch({ details: () => json({ error: 'nope' }, 500) });
    renderPage();

    expect(await screen.findByText(/^Błąd:/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '← Wróć do wyszukiwania' })).toHaveAttribute('href', '/');
  });
});
