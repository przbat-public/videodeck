import { act, render, renderHook, waitFor } from '@testing-library/react';
import type { StatusResponse } from '@videodeck/shared/api';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installFetchMock, jsonResponse } from '../test/fetchMock';
import { applyLibraryRevision, resetLibraryState } from '../utils/libraryStatus';
import { LIBRARY_FIRST_READ_GRACE_MS, useLibraryReadKey } from './useLibrary';
import { useStatus } from './useStatus';

/**
 * The read gate. A page used to read every library-backed endpoint at mount
 * and then read it again the moment the first library value landed, aborting
 * the first answer on the way: two full passes over the disks for one screen.
 * These tests count the requests, because that is the whole point.
 */

const fetchMock = installFetchMock();

const statusResponse: StatusResponse = {
  videosFolderPath: ['/videos/a'],
  folderConfigs: { '/videos/a': { channelUrl: 'https://yt/@a' } },
  downloadDefaults: { maxHeight: 2160, subLangs: ['en'], writeComments: true },
  indexedFolders: ['/videos/a'],
  listExists: { '/videos/a': true },
  unavailableFolders: [],
  status: 'ok',
  elasticsearch: 'ok',
};

/** The heaviest library-backed read on the status page */
function StatusProbe(): null {
  useStatus();
  return null;
}

const statusCalls = (): number => fetchMock.mock.calls.filter(([url]) => url === '/api/status').length;

describe('useLibraryReadKey', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    // The global setup hands every test a known revision; this suite is about
    // the state before one is known, so it starts from nothing
    resetLibraryState();
  });

  it('waits for the first library value, then reads that endpoint exactly once', async () => {
    fetchMock.mockResolvedValue(jsonResponse(statusResponse));
    render(<StatusProbe />);

    // Nothing is known yet: a read started here would be aborted by the one
    // that follows the baseline, which is the double pass this gate removes
    expect(statusCalls()).toBe(0);

    act(() => {
      applyLibraryRevision(4);
    });

    await waitFor(() => expect(statusCalls()).toBe(1));
    // The baseline is not a change: no second read follows it
    await act(async () => {
      await Promise.resolve();
    });
    expect(statusCalls()).toBe(1);
  });

  it('reads again, once, when the library actually moves', async () => {
    fetchMock.mockResolvedValue(jsonResponse(statusResponse));
    render(<StatusProbe />);
    act(() => {
      applyLibraryRevision(4);
    });
    await waitFor(() => expect(statusCalls()).toBe(1));

    act(() => {
      applyLibraryRevision(5);
    });

    await waitFor(() => expect(statusCalls()).toBe(2));
  });

  it('reads anyway once the grace period passes, so a dead server still reports itself', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fetchMock.mockResolvedValue(jsonResponse(statusResponse));
    render(<StatusProbe />);
    expect(statusCalls()).toBe(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIBRARY_FIRST_READ_GRACE_MS);
    });

    await waitFor(() => expect(statusCalls()).toBe(1));
    vi.useRealTimers();
  });

  it('reports the key the hooks read on: null before, the revision after', () => {
    const { result } = renderHook(() => useLibraryReadKey());

    expect(result.current).toBeNull();

    act(() => {
      applyLibraryRevision(7);
    });

    expect(result.current).toBe(7);
  });
});
