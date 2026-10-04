import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import i18n from '../i18n';
import type { FetchMock, MockResponse } from '../test/fetchMock';
import { installFetchMock, jsonResponse } from '../test/fetchMock';
import { useVideoState } from './useVideoState';

const fetchMock: FetchMock = installFetchMock();

const FOLDER = '/videos/kanal-a';
const VIDEO_ID = 'v1';
const STATE_URL = `/api/folder/video-state?folderPath=${encodeURIComponent(FOLDER)}&videoId=${VIDEO_ID}`;

const stateBody = (overrides: Record<string, unknown> = {}) => ({
  folderPath: FOLDER,
  videoId: VIDEO_ID,
  known: true,
  state: {
    files: {
      video: true,
      thumbnail: true,
      description: false,
      subLangs: ['en'],
      comments: false,
      videoBytes: 5242880,
      infoBytes: 4096,
    },
    archive: { onDisk: true, inArchive: false, drift: true },
    missing: ['comments'],
  },
  ...overrides,
});

describe('useVideoState', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('reads one video state for the panel', async () => {
    fetchMock.mockResolvedValue(jsonResponse(stateBody()));
    const { result } = renderHook(() => useVideoState(FOLDER, VIDEO_ID));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(fetchMock.mock.calls[0]?.[0]).toBe(STATE_URL);
    expect(result.current.known).toBe(true);
    expect(result.current.state?.files?.infoBytes).toBe(4096);
    expect(result.current.state?.missing).toEqual(['comments']);
  });

  it('reports a video the folder has never seen', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        folderPath: FOLDER,
        videoId: VIDEO_ID,
        known: false,
        state: { files: null, archive: { onDisk: false, inArchive: false, drift: false }, missing: [] },
      }),
    );
    const { result } = renderHook(() => useVideoState(FOLDER, VIDEO_ID));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.known).toBe(false);
  });

  it('reads the next video when the panel moves to another row', async () => {
    fetchMock.mockResolvedValue(jsonResponse(stateBody()));
    const { rerender } = renderHook(({ videoId }: { videoId: string }) => useVideoState(FOLDER, videoId), {
      initialProps: { videoId: VIDEO_ID },
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    rerender({ videoId: 'v2' });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1]?.[0]).toContain('videoId=v2');
  });

  it('asks for nothing while the panel is closed', () => {
    fetchMock.mockResolvedValue(jsonResponse(stateBody()));
    renderHook(() => useVideoState(FOLDER, VIDEO_ID, { enabled: false }));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports a read that failed, without leaking the parse error', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ state: 'nope' }));
    const { result } = renderHook(() => useVideoState(FOLDER, VIDEO_ID));

    await waitFor(() => expect(result.current.error).toBe(i18n.t('videoState.details.error')));
    expect(result.current.state).toBeNull();
  });

  it('keeps nothing from a read that a closing panel started', async () => {
    let release: ((response: MockResponse) => void) | undefined;
    fetchMock.mockImplementation(
      () =>
        new Promise<MockResponse>((resolve) => {
          release = resolve;
        }),
    );
    const { result, unmount } = renderHook(() => useVideoState(FOLDER, VIDEO_ID));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    unmount();
    release?.(jsonResponse(stateBody()));
    await Promise.resolve();

    expect(result.current.state).toBeNull();
    expect(result.current.error).toBeNull();
  });
});
