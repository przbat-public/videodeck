import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useLibraryRevision } from '../hooks/useLibrary';
import { libraryFrame } from '../test/libraryFrames';
import {
  applyLibraryFrame,
  applyLibraryRevision,
  getLibraryArrivals,
  getLibraryState,
  resetLibraryState,
  subscribeLibraryArrivals,
  subscribeLibraryFrames,
  subscribeLibraryState,
} from './libraryStatus';

describe('libraryStatus store', () => {
  beforeEach(() => {
    resetLibraryState();
  });

  it('keeps the folders and the revision of the newest frame', () => {
    applyLibraryFrame(
      libraryFrame({ revision: 4, folders: ['/videos/a', '/videos/b'], unavailable: ['/videos/gone'] }),
    );

    expect(getLibraryState()).toEqual({
      revision: 4,
      folders: ['/videos/a', '/videos/b'],
    });
  });

  it('notifies once for a newer revision, and never for the same or an older one', () => {
    const listener = vi.fn();
    subscribeLibraryState(listener);

    applyLibraryFrame(libraryFrame({ revision: 2, folders: ['/videos/a', '/videos/b'] }));
    expect(listener).toHaveBeenCalledTimes(1);

    applyLibraryFrame(libraryFrame({ revision: 2, folders: ['/videos/a', '/videos/b'] }));
    applyLibraryFrame(libraryFrame({ revision: 1, folders: ['/videos/a', '/videos/b'] }));
    applyLibraryRevision(0);
    expect(listener).toHaveBeenCalledTimes(1);

    applyLibraryRevision(3);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('moves the revision from the health poll without inventing folders', () => {
    applyLibraryFrame(libraryFrame({ revision: 2, folders: ['/videos/a'] }));
    applyLibraryRevision(7);

    expect(getLibraryState().revision).toBe(7);
    // The poll carries no library body, so what the last frame said stays
    expect(getLibraryState().folders).toEqual(['/videos/a']);
  });

  it('keeps one snapshot object until something actually moves', () => {
    applyLibraryFrame(libraryFrame({ revision: 3, folders: ['/videos/a'] }));
    const before = getLibraryState();

    applyLibraryRevision(3);
    applyLibraryFrame(libraryFrame({ revision: 3, folders: ['/videos/a'] }));

    // useSyncExternalStore compares by reference: a fresh object per read
    // would re-render every subscriber forever
    expect(getLibraryState()).toBe(before);
  });

  it('drops a frame older than the watermark, folders and all', () => {
    applyLibraryFrame(libraryFrame({ revision: 4, folders: ['/videos/a'] }));

    applyLibraryFrame(libraryFrame({ revision: 3, folders: ['/videos/stale'] }));

    expect(getLibraryState().folders).toEqual(['/videos/a']);
  });

  it('fills the folders in when the frame lands after the health poll', () => {
    // The poll carries the revision alone, so the frame that follows at that
    // same revision is still the first thing that describes the library
    applyLibraryRevision(7);
    applyLibraryFrame(libraryFrame({ revision: 7, folders: ['/videos/a'] }));

    expect(getLibraryState().folders).toEqual(['/videos/a']);
  });

  it('hands every accepted frame to the frame subscribers, with the change it computed', () => {
    const listener = vi.fn();
    subscribeLibraryFrames(listener);
    applyLibraryFrame(libraryFrame({ revision: 4, folders: ['/videos/a'] }));

    applyLibraryFrame(libraryFrame({ revision: 5, folders: ['/videos/a', '/videos/b'], added: [], removed: [] }));

    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({ revision: 5, added: ['/videos/b'], removed: [] }),
    );
  });

  it('announces a folder that arrived while the stream was not being read', () => {
    // A hidden tab drops the stream and comes back on an opening frame, which
    // carries no delta: the store has to see the change in the folder list
    // itself, or the drive that arrived in between is never announced
    const listener = vi.fn();
    subscribeLibraryFrames(listener);
    applyLibraryFrame(libraryFrame({ revision: 3, folders: ['/videos/a'] }));

    applyLibraryFrame(libraryFrame({ revision: 4, folders: ['/videos/a', '/videos/plugged-in'] }));

    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ added: ['/videos/plugged-in'], removed: [] }));
  });

  it('keeps one notice entry when a folder leaves and comes back before it is read', () => {
    // The notice lists what arrived since the operator last saw it, so a drive
    // unplugged and plugged back in must not be announced a second time
    const arrivals = vi.fn();
    const unsubscribe = subscribeLibraryArrivals(arrivals);
    applyLibraryFrame(libraryFrame({ revision: 3, folders: ['/videos/a'] }));
    applyLibraryFrame(libraryFrame({ revision: 4, folders: ['/videos/a', '/videos/plugged-in'] }));
    expect(getLibraryArrivals()).toEqual(['/videos/plugged-in']);
    arrivals.mockClear();

    applyLibraryFrame(libraryFrame({ revision: 5, folders: ['/videos/a'] }));
    applyLibraryFrame(libraryFrame({ revision: 6, folders: ['/videos/a', '/videos/plugged-in'] }));
    unsubscribe();

    expect(getLibraryArrivals()).toEqual(['/videos/plugged-in']);
    expect(arrivals).not.toHaveBeenCalled();
  });

  it('stops handing frames to a subscriber that unsubscribed', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeLibraryFrames(listener);
    applyLibraryFrame(libraryFrame({ revision: 3, folders: ['/videos/a'] }));
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    applyLibraryFrame(libraryFrame({ revision: 4, folders: ['/videos/a', '/videos/b'] }));

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('treats the first frame of a session as a snapshot, not as a change', () => {
    // Nothing was known before it, so every folder in it would otherwise look
    // like a drive that just arrived, and the notice would greet every reload
    const listener = vi.fn();
    subscribeLibraryFrames(listener);

    applyLibraryFrame(libraryFrame({ revision: 9, folders: ['/videos/a', '/videos/b'] }));

    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ added: [], removed: [] }));
  });

  it('reports a folder that left with the same computation', () => {
    const listener = vi.fn();
    subscribeLibraryFrames(listener);
    applyLibraryFrame(libraryFrame({ revision: 3, folders: ['/videos/a', '/videos/b'] }));

    applyLibraryFrame(libraryFrame({ revision: 4, folders: ['/videos/a'] }));

    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ added: [], removed: ['/videos/b'] }));
  });

  it('re-renders the hooks when the revision moves', () => {
    const { result } = renderHook(() => useLibraryRevision());

    expect(result.current).toBe(0);

    act(() => {
      applyLibraryFrame(libraryFrame({ revision: 6, folders: ['/videos/a', '/videos/b'] }));
    });

    expect(result.current).toBe(6);
    expect(getLibraryState().folders).toEqual(['/videos/a', '/videos/b']);
  });
});
