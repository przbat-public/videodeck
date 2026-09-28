import { act, renderHook } from '@testing-library/react';
import type { LibraryEvent } from '@videodeck/shared/api';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useLibraryRevision, useLibraryState } from '../hooks/useLibrary';
import {
  applyLibraryFrame,
  applyLibraryRevision,
  getLibraryState,
  resetLibraryState,
  setLibraryStreamOpen,
  subscribeLibraryFrames,
  subscribeLibraryState,
} from './libraryStatus';

/** One frame of GET /api/events; the opening frame carries no added/removed */
const frame = (overrides: Partial<LibraryEvent> = {}): LibraryEvent => ({
  type: 'library',
  revision: 1,
  folders: ['/videos/a'],
  unavailable: [],
  ...overrides,
});

describe('libraryStatus store', () => {
  beforeEach(() => {
    resetLibraryState();
  });

  it('keeps the folders, the unavailable list and the revision of the newest frame', () => {
    applyLibraryFrame(frame({ revision: 4, folders: ['/videos/a', '/videos/b'], unavailable: ['/videos/gone'] }));

    expect(getLibraryState()).toEqual({
      revision: 4,
      folders: ['/videos/a', '/videos/b'],
      unavailable: ['/videos/gone'],
      streamOpen: false,
    });
  });

  it('notifies once for a newer revision, and never for the same or an older one', () => {
    const listener = vi.fn();
    subscribeLibraryState(listener);

    applyLibraryFrame(frame({ revision: 2 }));
    expect(listener).toHaveBeenCalledTimes(1);

    applyLibraryFrame(frame({ revision: 2 }));
    applyLibraryFrame(frame({ revision: 1 }));
    applyLibraryRevision(0);
    expect(listener).toHaveBeenCalledTimes(1);

    applyLibraryRevision(3);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('moves the revision from the health poll without inventing folders', () => {
    applyLibraryFrame(frame({ revision: 2, folders: ['/videos/a'], unavailable: ['/videos/gone'] }));
    applyLibraryRevision(7);

    expect(getLibraryState().revision).toBe(7);
    // The poll carries no library body, so what the last frame said stays
    expect(getLibraryState().folders).toEqual(['/videos/a']);
    expect(getLibraryState().unavailable).toEqual(['/videos/gone']);
  });

  it('keeps one snapshot object until something actually moves', () => {
    applyLibraryFrame(frame({ revision: 3, folders: ['/videos/a'] }));
    const before = getLibraryState();

    applyLibraryRevision(3);
    applyLibraryFrame(frame({ revision: 3, folders: ['/videos/a'] }));

    // useSyncExternalStore compares by reference: a fresh object per read
    // would re-render every subscriber forever
    expect(getLibraryState()).toBe(before);
  });

  it('drops a frame older than the watermark, folders and all', () => {
    applyLibraryFrame(frame({ revision: 4, folders: ['/videos/a'] }));

    applyLibraryFrame(frame({ revision: 3, folders: ['/videos/stale'] }));

    expect(getLibraryState().folders).toEqual(['/videos/a']);
  });

  it('fills the folders in when the frame lands after the health poll', () => {
    // The poll carries the revision alone, so the frame that follows at that
    // same revision is still the first thing that describes the library
    applyLibraryRevision(7);
    applyLibraryFrame(frame({ revision: 7, folders: ['/videos/a'] }));

    expect(getLibraryState().folders).toEqual(['/videos/a']);
  });

  it('hands every accepted frame to the frame subscribers, with what it added', () => {
    const listener = vi.fn();
    subscribeLibraryFrames(listener);
    const change = frame({ revision: 5, added: ['/videos/new'], removed: [] });

    applyLibraryFrame(change);

    expect(listener).toHaveBeenCalledWith(change);
  });

  it('reports an open stream and notifies only when it flips', () => {
    const listener = vi.fn();
    subscribeLibraryState(listener);

    setLibraryStreamOpen(true);
    setLibraryStreamOpen(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getLibraryState().streamOpen).toBe(true);

    setLibraryStreamOpen(false);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('re-renders the hooks when the revision moves', () => {
    const { result } = renderHook(() => ({
      revision: useLibraryRevision(),
      state: useLibraryState(),
    }));

    expect(result.current.revision).toBe(0);

    act(() => {
      applyLibraryFrame(frame({ revision: 6, folders: ['/videos/a', '/videos/b'] }));
    });

    expect(result.current.revision).toBe(6);
    expect(result.current.state.folders).toEqual(['/videos/a', '/videos/b']);
  });
});
