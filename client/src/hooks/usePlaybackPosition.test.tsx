import { fireEvent, render, screen } from '@testing-library/react';
import type { JSX } from 'react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatPlaybackTime, playbackPositionKey, usePlaybackPosition } from './usePlaybackPosition';

/** What an earlier visit left behind; the hook reads exactly this shape */
function seedPosition(videoId: string, time: number, duration: number): void {
  localStorage.setItem(playbackPositionKey(videoId), JSON.stringify({ time, duration }));
}

/** The stored entry, parsed, or null when nothing was written */
function storedEntry(videoId: string): unknown {
  return JSON.parse(localStorage.getItem(playbackPositionKey(videoId)) ?? 'null');
}

/** jsdom has no media pipeline: only currentTime and duration matter here */
function setPlayerState(player: HTMLVideoElement, currentTime: number, duration: number): void {
  player.currentTime = currentTime;
  Object.defineProperty(player, 'duration', { value: duration, configurable: true });
}

/** The player wired the way VideoDetailPage wires it: element as state, not as a ref */
function Harness({ videoId }: { videoId: string }): JSX.Element {
  const [player, setPlayer] = useState<HTMLVideoElement | null>(null);
  const { position, clear } = usePlaybackPosition(videoId, player);
  return (
    <div>
      <span data-testid="offer">{position ?? 'none'}</span>
      <button type="button" onClick={clear}>
        forget
      </button>
      {/* biome-ignore lint/a11y/useMediaCaption: the harness needs a player element, it plays nothing */}
      <video data-testid="player" ref={setPlayer} />
    </div>
  );
}

describe('usePlaybackPosition', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('offers nothing for a video that was never watched', () => {
    render(<Harness videoId="hedgehogs" />);

    expect(screen.getByTestId('offer')).toHaveTextContent('none');
  });

  it('remembers the place on unmount and offers it on the next visit', () => {
    const { unmount } = render(<Harness videoId="hedgehogs" />);
    setPlayerState(screen.getByTestId('player') as HTMLVideoElement, 300, 1200);

    unmount();

    expect(storedEntry('hedgehogs')).toEqual({ time: 300, duration: 1200 });

    render(<Harness videoId="hedgehogs" />);
    expect(screen.getByTestId('offer')).toHaveTextContent('300');
  });

  it('keeps the last sample when the viewer pauses', () => {
    render(<Harness videoId="hedgehogs" />);
    const player = screen.getByTestId('player') as HTMLVideoElement;
    setPlayerState(player, 640, 1200);

    fireEvent.pause(player);

    expect(storedEntry('hedgehogs')).toEqual({ time: 640, duration: 1200 });
  });

  it('writes at most one sample per interval while the video plays', () => {
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    render(<Harness videoId="hedgehogs" />);
    const player = screen.getByTestId('player') as HTMLVideoElement;

    setPlayerState(player, 30, 1200);
    fireEvent.timeUpdate(player);

    // Inside the interval: the sample is dropped instead of hitting storage
    setPlayerState(player, 45, 1200);
    now += 1_000;
    fireEvent.timeUpdate(player);
    expect(storedEntry('hedgehogs')).toEqual({ time: 30, duration: 1200 });

    // Past the interval: the newest place is written
    setPlayerState(player, 60, 1200);
    now += 5_000;
    fireEvent.timeUpdate(player);
    expect(storedEntry('hedgehogs')).toEqual({ time: 60, duration: 1200 });
  });

  it('leaves the stored place alone when the viewer never played', () => {
    seedPosition('hedgehogs', 300, 1200);
    const { unmount } = render(<Harness videoId="hedgehogs" />);

    unmount();

    expect(storedEntry('hedgehogs')).toEqual({ time: 300, duration: 1200 });
  });

  it('rejects a place in the first seconds', () => {
    seedPosition('hedgehogs', 8, 1200);
    render(<Harness videoId="hedgehogs" />);

    expect(screen.getByTestId('offer')).toHaveTextContent('none');
  });

  it('rejects a place in the last stretch of the video', () => {
    seedPosition('hedgehogs', 1190, 1200);
    render(<Harness videoId="hedgehogs" />);

    expect(screen.getByTestId('offer')).toHaveTextContent('none');
  });

  it('offers a place whose video length was never recorded', () => {
    seedPosition('hedgehogs', 300, 0);
    render(<Harness videoId="hedgehogs" />);

    expect(screen.getByTestId('offer')).toHaveTextContent('300');
  });

  it('follows the video the page is showing', () => {
    seedPosition('hedgehogs', 300, 1200);
    seedPosition('otters', 600, 1800);
    const { rerender } = render(<Harness videoId="hedgehogs" />);
    expect(screen.getByTestId('offer')).toHaveTextContent('300');

    rerender(<Harness videoId="otters" />);

    expect(screen.getByTestId('offer')).toHaveTextContent('600');
  });

  it('forgets the stored place when the viewer starts over', () => {
    seedPosition('hedgehogs', 300, 1200);
    render(<Harness videoId="hedgehogs" />);

    fireEvent.click(screen.getByRole('button', { name: 'forget' }));

    expect(localStorage.getItem(playbackPositionKey('hedgehogs'))).toBeNull();
    expect(screen.getByTestId('offer')).toHaveTextContent('none');
  });

  it('treats a damaged entry as no place at all', () => {
    localStorage.setItem(playbackPositionKey('hedgehogs'), 'not json');

    render(<Harness videoId="hedgehogs" />);

    expect(screen.getByTestId('offer')).toHaveTextContent('none');
  });

  it('survives storage that refuses to be read', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });

    expect(() => render(<Harness videoId="hedgehogs" />)).not.toThrow();
  });

  it('survives storage that refuses to be written', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('denied');
    });
    render(<Harness videoId="hedgehogs" />);
    const player = screen.getByTestId('player') as HTMLVideoElement;
    setPlayerState(player, 300, 1200);

    expect(() => {
      fireEvent.timeUpdate(player);
      fireEvent.click(screen.getByRole('button', { name: 'forget' }));
    }).not.toThrow();
  });
});

describe('playbackPositionKey', () => {
  it('keeps the position clear of the theme key', () => {
    expect(playbackPositionKey('hedgehogs')).toBe('videodeck-playback-position:hedgehogs');
    expect(playbackPositionKey('hedgehogs')).not.toBe('videodeck-theme');
  });
});

describe('formatPlaybackTime', () => {
  it('pads the seconds and leaves the minutes alone below an hour', () => {
    expect(formatPlaybackTime(9)).toBe('0:09');
    expect(formatPlaybackTime(754)).toBe('12:34');
  });

  it('adds the hour once the video needs one', () => {
    expect(formatPlaybackTime(3723)).toBe('1:02:03');
  });
});
