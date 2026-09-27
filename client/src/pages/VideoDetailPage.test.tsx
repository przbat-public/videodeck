import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { VideoDetails } from '@videodeck/shared/api';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { playbackPositionKey } from '../hooks/usePlaybackPosition';
import i18n from '../i18n';
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

/** What an earlier visit left behind; the hook and the page read this shape */
function seedPosition(videoId: string, time: number, duration: number): void {
  localStorage.setItem(playbackPositionKey(videoId), JSON.stringify({ time, duration }));
}

/** jsdom plays nothing: currentTime and duration are the only state that matters */
function setPlayback(player: HTMLVideoElement, currentTime: number, duration: number): void {
  player.currentTime = currentTime;
  Object.defineProperty(player, 'duration', { value: duration, configurable: true });
}

interface MediaSessionStub {
  metadata: MediaMetadata | null;
  /** Registered actions, as the browser would hold them */
  handlers: Map<MediaSessionAction, MediaSessionActionHandler>;
  setActionHandler: (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => void;
}

/** navigator.mediaSession is missing from jsdom, so the page gets a stub that remembers */
function installMediaSession(): MediaSessionStub {
  const handlers = new Map<MediaSessionAction, MediaSessionActionHandler>();
  const session: MediaSessionStub = {
    metadata: null,
    handlers,
    setActionHandler: vi.fn((action: MediaSessionAction, handler: MediaSessionActionHandler | null): void => {
      if (handler === null) {
        handlers.delete(action);
      } else {
        handlers.set(action, handler);
      }
    }),
  };
  Object.defineProperty(navigator, 'mediaSession', { value: session, configurable: true });
  return session;
}

/** MediaMetadata is missing from jsdom for the same reason */
class FakeMediaMetadata {
  title: string;
  artist: string;
  artwork: MediaImage[];

  constructor(init: MediaMetadataInit = {}) {
    this.title = init.title ?? '';
    this.artist = init.artist ?? '';
    this.artwork = init.artwork ?? [];
  }
}

describe('VideoDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installFetch();
  });

  afterEach(() => {
    // document.title is document-wide: never let one test's title answer for
    // the next one's assertion.
    document.title = '';
  });

  it('shows a spinner while loading', () => {
    renderPage();

    expect(screen.getByText('Ładowanie filmu...')).toBeInTheDocument();
  });

  it('titles the loading screen before the video arrives', () => {
    renderPage();

    expect(document.title).toBe(i18n.t('pageTitle.videoLoading'));
  });

  it('titles the document after the video', async () => {
    renderPage();

    expect(await screen.findByText('A talk about hedgehogs')).toBeInTheDocument();
    // The title is data from the API, not a translated label
    expect(document.title).toContain('A talk about hedgehogs');
    expect(document.title).toBe(i18n.t('pageTitle.video', { title: 'A talk about hedgehogs' }));
  });

  it('titles the failed screen when the video cannot be shown', async () => {
    installFetch({ details: () => json({ error: 'nope' }, 500) });
    renderPage();

    await screen.findByText(/^Błąd:/);
    expect(document.title).toBe(i18n.t('pageTitle.videoError'));
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

  it('shows an error when the request fails', async () => {
    installFetch({ details: () => json({ error: 'nope' }, 500) });
    renderPage();

    expect(await screen.findByText(/^Błąd:/)).toBeInTheDocument();
  });

  it('retries the failed details request and keeps the page in a landmark', async () => {
    let failNext = true;
    installFetch({
      details: () => {
        if (failNext) {
          failNext = false;
          return json({ error: 'nope' }, 500);
        }
        return json({ details });
      },
    });
    const user = userEvent.setup();
    renderPage();
    await screen.findByText(/^Błąd:/);

    // The error screen is the page: it has to sit in the main landmark, not
    // outside every landmark like the plain div it used to be.
    expect(screen.getByRole('main')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Spróbuj ponownie' }));

    expect(await screen.findByText('A talk about hedgehogs')).toBeInTheDocument();
    expect(screen.queryByText(/^Błąd:/)).toBeNull();
  });

  describe('the Media Session API', () => {
    beforeEach(() => {
      globalThis.MediaMetadata = FakeMediaMetadata as unknown as typeof MediaMetadata;
      // jsdom reports both of these as not implemented; the page only has to call them
      vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
      vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    });

    afterEach(() => {
      Reflect.deleteProperty(navigator, 'mediaSession');
      Reflect.deleteProperty(globalThis, 'MediaMetadata');
      vi.restoreAllMocks();
    });

    it('keeps iOS from taking the video full screen and reads only the header', async () => {
      renderPage();

      const player = await screen.findByTestId('video-player');
      expect(player).toHaveAttribute('playsinline');
      expect(player).toHaveAttribute('preload', 'metadata');
    });

    it('publishes the title, the channel and the poster to the OS', async () => {
      const session = installMediaSession();
      renderPage();

      await screen.findByTestId('video-player');

      expect(session.metadata?.title).toBe('A talk about hedgehogs');
      expect(session.metadata?.artist).toBe('Nature');
      expect(session.metadata?.artwork).toEqual([
        { src: `/api/videos/file/hedgehogs.webp?folder=${encodeURIComponent('/videos/a')}` },
      ]);
      expect([...session.handlers.keys()].sort()).toEqual(['pause', 'play', 'seekbackward', 'seekforward', 'seekto']);
    });

    it('routes the media keys to the player', async () => {
      const session = installMediaSession();
      renderPage();
      const player = (await screen.findByTestId('video-player')) as HTMLVideoElement;
      setPlayback(player, 100, 600);

      session.handlers.get('seekforward')?.({ action: 'seekforward', seekOffset: 15 });
      expect(player.currentTime).toBe(115);

      // Without an offset the player falls back to its own step
      session.handlers.get('seekbackward')?.({ action: 'seekbackward' });
      expect(player.currentTime).toBe(105);

      session.handlers.get('seekto')?.({ action: 'seekto', seekTime: 42 });
      expect(player.currentTime).toBe(42);
    });

    it('stays inside the video when a media key seeks past either end', async () => {
      const session = installMediaSession();
      renderPage();
      const player = (await screen.findByTestId('video-player')) as HTMLVideoElement;

      setPlayback(player, 2, 600);
      session.handlers.get('seekbackward')?.({ action: 'seekbackward', seekOffset: 10 });
      expect(player.currentTime).toBe(0);

      setPlayback(player, 595, 600);
      session.handlers.get('seekforward')?.({ action: 'seekforward', seekOffset: 10 });
      expect(player.currentTime).toBe(600);
    });

    it('starts and stops playback from the OS controls', async () => {
      const session = installMediaSession();
      renderPage();
      await screen.findByTestId('video-player');

      session.handlers.get('play')?.({ action: 'play' });
      expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();

      session.handlers.get('pause')?.({ action: 'pause' });
      expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
    });

    it('drops the metadata and the handlers when the page goes away', async () => {
      const session = installMediaSession();
      const { unmount } = renderPage();
      await screen.findByTestId('video-player');
      expect(session.handlers.size).toBe(5);

      unmount();

      expect(session.metadata).toBeNull();
      expect(session.handlers.size).toBe(0);
    });
  });

  describe('resuming where the viewer stopped', () => {
    beforeEach(() => {
      localStorage.clear();
      vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    });

    afterEach(() => {
      localStorage.clear();
      vi.restoreAllMocks();
    });

    it('offers the stored place and seeks the player there', async () => {
      seedPosition('hedgehogs', 754, 1800);
      const user = userEvent.setup();
      renderPage();
      const resume = await screen.findByRole('button', {
        name: i18n.t('video.resumeFrom', { time: '12:34' }),
      });
      const player = screen.getByTestId('video-player') as HTMLVideoElement;
      setPlayback(player, 0, 1800);

      await user.click(resume);

      expect(player.currentTime).toBe(754);
      expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
      // The offer is answered, so it goes away
      expect(screen.queryByRole('button', { name: i18n.t('video.resumeFrom', { time: '12:34' }) })).toBeNull();
    });

    it('takes the offer away once the viewer starts playing by hand', async () => {
      seedPosition('hedgehogs', 754, 1800);
      renderPage();
      const player = (await screen.findByTestId('video-player')) as HTMLVideoElement;
      const offer = i18n.t('video.resumeFrom', { time: '12:34' });
      expect(screen.getByRole('button', { name: offer })).toBeInTheDocument();

      // Playing from the native controls is an answer too: the offer must not
      // jump the viewer back later.
      fireEvent.play(player);

      expect(screen.queryByRole('button', { name: offer })).toBeNull();
    });

    it('starts over and forgets the stored place', async () => {
      seedPosition('hedgehogs', 754, 1800);
      const user = userEvent.setup();
      renderPage();
      await screen.findByRole('button', { name: i18n.t('video.resumeFrom', { time: '12:34' }) });
      const player = screen.getByTestId('video-player') as HTMLVideoElement;
      setPlayback(player, 754, 1800);

      await user.click(screen.getByRole('button', { name: i18n.t('video.startFromBeginning') }));

      expect(player.currentTime).toBe(0);
      expect(localStorage.getItem(playbackPositionKey('hedgehogs'))).toBeNull();
      expect(screen.queryByRole('button', { name: i18n.t('video.startFromBeginning') })).toBeNull();
    });

    it('offers nothing for a video that was never watched', async () => {
      renderPage();

      await screen.findByTestId('video-player');

      expect(screen.queryByRole('button', { name: i18n.t('video.startFromBeginning') })).toBeNull();
    });

    it('offers nothing for a place in the first seconds', async () => {
      seedPosition('hedgehogs', 8, 1800);
      renderPage();

      await screen.findByTestId('video-player');

      expect(screen.queryByRole('button', { name: i18n.t('video.startFromBeginning') })).toBeNull();
    });

    it('offers nothing for a place in the last stretch of the video', async () => {
      seedPosition('hedgehogs', 1790, 1800);
      renderPage();

      await screen.findByTestId('video-player');

      expect(screen.queryByRole('button', { name: i18n.t('video.startFromBeginning') })).toBeNull();
    });
  });
});
