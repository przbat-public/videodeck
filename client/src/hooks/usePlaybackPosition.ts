import { useCallback, useEffect, useState } from 'react';

/** How far a video has to have run before its place is worth offering back */
const MIN_RESUME_SECONDS = 10;

/** How much of the video has to be left, so the offer is not about the closing credits */
const MIN_REMAINING_SECONDS = 15;

/** How often a playing video is sampled; a pause and a departure write right away */
const SAVE_INTERVAL_MS = 5_000;

/** A place in a video, as stored: seconds in, and the length the player reported */
interface StoredPosition {
  time: number;
  /** 0 when the player had not read the video's length yet */
  duration: number;
}

/**
 * The localStorage key holding one video's place. Namespaced so it cannot
 * collide with `videodeck-theme`, the other key this client owns.
 */
export function playbackPositionKey(videoId: string): string {
  return `videodeck-playback-position:${videoId}`;
}

/** A position as a clock reading: `mm:ss`, or `h:mm:ss` past the hour */
export function formatPlaybackTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return minutes >= 60
    ? `${Math.floor(minutes / 60)}:${pad(minutes % 60)}:${pad(total % 60)}`
    : `${minutes}:${pad(total % 60)}`;
}

/** The stored entry for a video, or null when it is missing or damaged */
function readStoredPosition(videoId: string): StoredPosition | null {
  try {
    const raw = localStorage.getItem(playbackPositionKey(videoId));
    if (raw === null) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    const { time, duration } = parsed as { time?: unknown; duration?: unknown };
    return typeof time === 'number' && typeof duration === 'number' ? { time, duration } : null;
  } catch {
    // Storage can be denied outright, and an entry can be anything at all;
    // both mean "no place to come back to", never a broken page.
    return null;
  }
}

/**
 * The place worth offering back: far enough in that the video actually started,
 * and far enough from the end that resuming still shows something. A video whose
 * length was never recorded only has to clear the opening seconds.
 */
function readResumePosition(videoId: string | undefined): number | null {
  if (!videoId) {
    return null;
  }
  const stored = readStoredPosition(videoId);
  if (stored === null || !Number.isFinite(stored.time) || stored.time < MIN_RESUME_SECONDS) {
    return null;
  }
  if (stored.duration > 0 && stored.duration - stored.time < MIN_REMAINING_SECONDS) {
    return null;
  }
  return stored.time;
}

/** Sample the player, unless it is too close to the start to be worth keeping */
function writePosition(videoId: string, player: HTMLVideoElement): void {
  const time = player.currentTime;
  // Opening a video and leaving without playing is not "at 0s": writing that
  // would throw away the place an earlier visit saved.
  if (!Number.isFinite(time) || time <= 0) {
    return;
  }
  const stored: StoredPosition = {
    time,
    duration: Number.isFinite(player.duration) && player.duration > 0 ? player.duration : 0,
  };
  try {
    localStorage.setItem(playbackPositionKey(videoId), JSON.stringify(stored));
  } catch {
    // A full quota and a private-mode store both throw here; a lost place is
    // never a reason to take playback down with it.
  }
}

/** Drop the remembered place, so the next visit starts at the beginning */
function clearStoredPosition(videoId: string | undefined): void {
  if (!videoId) {
    return;
  }
  try {
    localStorage.removeItem(playbackPositionKey(videoId));
  } catch {
    // Same as above: storage that refuses to be written is not an error here.
  }
}

/**
 * The place a viewer stopped at in this video, and the way to forget it.
 *
 * The player arrives as state rather than as a ref: the page mounts it only once
 * the details are in, and the listeners have to attach at that moment, not at
 * the moment the page first rendered. While the video plays, the position is
 * sampled at most once every SAVE_INTERVAL_MS; a pause and the unmount write
 * right away, because those are the moments a viewer leaves. Nothing here starts
 * playback: the stored place is an offer, and the page renders the buttons that
 * accept or refuse it.
 */
export function usePlaybackPosition(
  videoId: string | undefined,
  player: HTMLVideoElement | null,
): { position: number | null; clear: () => void } {
  const [stored, setStored] = useState<{ videoId: string | undefined; position: number | null }>(() => ({
    videoId,
    position: readResumePosition(videoId),
  }));

  // The route keeps this page mounted while the viewer moves between videos, so
  // the offer has to follow the id. React supports writing state during render
  // for exactly this shape: the previous key is kept in state and compared.
  if (stored.videoId !== videoId) {
    setStored({ videoId, position: readResumePosition(videoId) });
  }

  useEffect(() => {
    if (!videoId || !player) {
      return;
    }
    // Nothing has been written yet in this visit, so the first sample lands.
    let lastSavedAt = Number.NEGATIVE_INFINITY;
    const save = (force: boolean): void => {
      const now = Date.now();
      if (!force && now - lastSavedAt < SAVE_INTERVAL_MS) {
        return;
      }
      lastSavedAt = now;
      writePosition(videoId, player);
    };
    const onTimeUpdate = (): void => save(false);
    const onPause = (): void => save(true);
    player.addEventListener('timeupdate', onTimeUpdate);
    player.addEventListener('pause', onPause);
    return () => {
      player.removeEventListener('timeupdate', onTimeUpdate);
      player.removeEventListener('pause', onPause);
      // Leaving the video, or switching to another one, is the last chance to
      // remember the place.
      save(true);
    };
  }, [player, videoId]);

  const clear = useCallback((): void => {
    clearStoredPosition(videoId);
    setStored({ videoId, position: null });
  }, [videoId]);

  return { position: stored.position, clear };
}
