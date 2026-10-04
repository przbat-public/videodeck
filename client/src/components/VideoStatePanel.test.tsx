import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n';
import type { FetchMock } from '../test/fetchMock';
import { installFetchMock, jsonResponse } from '../test/fetchMock';
import { toast } from '../test/toastMock';
import { formatBytes } from '../utils/videoState';
import { VideoStatePanel } from './VideoStatePanel';

const fetchMock: FetchMock = installFetchMock();

const FOLDER = '/videos/kanal-a';
const VIDEO = { id: 'v1', title: 'Film pierwszy' };
const STATE_URL = `/api/folder/video-state?folderPath=${encodeURIComponent(FOLDER)}&videoId=v1`;

const body = (overrides: Record<string, unknown> = {}) => ({
  folderPath: FOLDER,
  videoId: VIDEO.id,
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
    missing: ['description', 'pl'],
  },
  ...overrides,
});

const repairJob = {
  id: 'job-v1',
  folderPath: FOLDER,
  videoId: VIDEO.id,
  videoUrl: 'https://youtu.be/v1',
  type: 'repair' as const,
  status: 'queued' as const,
  log: [],
  logLineCount: 0,
  createdAt: '2026-09-19T10:00:00.000Z',
};

const renderPanel = (onQueueChanged = vi.fn()) => {
  render(<VideoStatePanel folderPath={FOLDER} video={VIDEO} onQueueChanged={onQueueChanged} />);
  return { onQueueChanged };
};

describe('VideoStatePanel', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.clearAllMocks();
  });

  it('shows the file state of the video it was opened for', async () => {
    fetchMock.mockResolvedValue(jsonResponse(body()));
    renderPanel();

    expect(await screen.findByText(i18n.t('videoState.details.video'))).toBeInTheDocument();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(STATE_URL);
    // Both sizes read as byte counts, not as raw numbers of bytes
    expect(screen.getByText(formatBytes(5242880, i18n.language))).toBeInTheDocument();
    expect(screen.getByText(formatBytes(4096, i18n.language))).toBeInTheDocument();
    expect(screen.getByText('en')).toBeInTheDocument();
    expect(screen.getByText(i18n.t('videoState.details.archiveOnDisk'))).toBeInTheDocument();
    expect(screen.getByText(i18n.t('videoState.details.archiveDrift'))).toBeInTheDocument();
    expect(screen.getByText(i18n.t('videoState.missing.description'))).toBeInTheDocument();
    expect(screen.getByText(i18n.t('videoState.missing.subtitle', { lang: 'pl' }))).toBeInTheDocument();
  });

  it('names the panel for a screen reader after the video it belongs to', async () => {
    fetchMock.mockResolvedValue(jsonResponse(body()));
    renderPanel();

    expect(
      await screen.findByRole('region', { name: i18n.t('videoState.details.regionLabel', { title: VIDEO.title }) }),
    ).toBeInTheDocument();
  });

  it('queues a repair for this one video and tells the section to re-read', async () => {
    const user = userEvent.setup();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(body()))
      .mockResolvedValueOnce(jsonResponse({ jobs: [repairJob], skipped: [] }, 202));
    const { onQueueChanged } = renderPanel();

    await user.click(await screen.findByRole('button', { name: i18n.t('videoState.details.repair') }));

    await waitFor(() => expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/folder/repair'));
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      folderPath: FOLDER,
      method: 'sidecars',
      videos: [{ videoId: VIDEO.id }],
    });
    expect(toast.success).toHaveBeenCalledWith(i18n.t('toast.repairQueued', { count: 1 }));
    expect(onQueueChanged).toHaveBeenCalledTimes(1);
  });

  it('offers no repair for a video that has everything', async () => {
    fetchMock.mockResolvedValue(jsonResponse(body({ state: { ...body().state, missing: [] } })));
    renderPanel();

    await screen.findByText(i18n.t('videoState.details.video'));
    expect(screen.queryByRole('button', { name: i18n.t('videoState.details.repair') })).toBeNull();
    expect(screen.getByText(i18n.t('videoState.details.nothingMissing'))).toBeInTheDocument();
  });

  it('says when the folder does not have the video at all', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        folderPath: FOLDER,
        videoId: VIDEO.id,
        known: false,
        state: { files: null, archive: { onDisk: false, inArchive: false, drift: false }, missing: [] },
      }),
    );
    renderPanel();

    expect(await screen.findByText(i18n.t('videoState.details.unknown'))).toBeInTheDocument();
  });

  it('reports a read that failed without hiding the panel', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'folder not allowed' }, 403));
    renderPanel();

    expect(await screen.findByText(i18n.t('app.error', { message: 'folder not allowed' }))).toBeInTheDocument();
    expect(screen.getByRole('region')).toBeInTheDocument();
  });

  it('reports a repair the server refused', async () => {
    const user = userEvent.setup();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(body()))
      .mockResolvedValueOnce(jsonResponse({ error: 'folder not allowed' }, 400));
    renderPanel();

    await user.click(await screen.findByRole('button', { name: i18n.t('videoState.details.repair') }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('folder not allowed'));
  });
});
