import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { QueueJob } from '@shared/api';
import { VideoItem } from './VideoItem';
import type { ChannelVideoRow } from './VideoItem';

const video: ChannelVideoRow = {
  id: 'abc123',
  title: 'Test Video',
  url: 'https://www.youtube.com/watch?v=abc123',
};

const job = (overrides: Partial<QueueJob>): QueueJob => ({
  id: 'job-1',
  folderPath: '/videos/a',
  videoId: 'abc123',
  videoUrl: video.url,
  type: 'download',
  status: 'queued',
  log: [],
  logLineCount: 0,
  createdAt: '2024-01-01T00:00:00.000Z',
  ...overrides,
});

const renderItem = (props: Partial<React.ComponentProps<typeof VideoItem>> = {}) => {
  const onEnqueue = vi.fn();
  const onCancel = vi.fn();
  render(
    <MemoryRouter>
      <VideoItem
        video={video}
        isDownloaded={false}
        onEnqueue={onEnqueue}
        onCancel={onCancel}
        {...props}
      />
    </MemoryRouter>
  );
  return { onEnqueue, onCancel };
};

describe('VideoItem', () => {
  it('links to YouTube and offers a download when not downloaded', async () => {
    const user = userEvent.setup();
    const { onEnqueue } = renderItem();

    const link = screen.getByRole('link', { name: 'Test Video' });
    expect(link).toHaveAttribute('href', video.url);

    await user.click(screen.getByRole('button', { name: 'Pobierz' }));
    expect(onEnqueue).toHaveBeenCalledWith(video, 'download');
  });

  it('links to the detail page and offers an update when downloaded', async () => {
    const user = userEvent.setup();
    const { onEnqueue } = renderItem({
      isDownloaded: true,
      video: { ...video, lastUpdated: '2024-03-05T10:20:00.000Z' },
    });

    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', '/video/abc123');
    expect(link.textContent).toMatch(/aktualizacja: /);

    await user.click(screen.getByRole('button', { name: 'Aktualizuj' }));
    expect(onEnqueue).toHaveBeenCalledWith(expect.objectContaining({ id: 'abc123' }), 'update');
  });

  it('disables the action when the video has no url', () => {
    renderItem({ video: { ...video, url: '' } });

    expect(screen.getByRole('button', { name: 'Pobierz' })).toBeDisabled();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('shows queue position and a cancel button for a queued job', async () => {
    const user = userEvent.setup();
    const { onCancel } = renderItem({ job: job({ status: 'queued' }) });

    expect(screen.getByText('Pobieranie: w kolejce')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pobierz' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Anuluj' }));
    expect(onCancel).toHaveBeenCalledWith('job-1');
  });

  it('shows progress and the log tail while running', () => {
    renderItem({
      job: job({ status: 'running', progress: 42.4, log: ['[download] 42.4% of 10MiB', 'line 2'] }),
    });

    expect(screen.getByText('Pobieranie: 42%')).toBeInTheDocument();
    expect(screen.getByText('[download] 42.4% of 10MiB')).toBeInTheDocument();
    expect(screen.getByText('line 2')).toBeInTheDocument();
  });

  it('shows a plain "Aktualizacja..." status for running update jobs', () => {
    renderItem({
      isDownloaded: true,
      job: job({ type: 'update', status: 'running', progress: 0 }),
    });

    expect(screen.getByText('Aktualizacja...')).toBeInTheDocument();
  });

  it('shows the error and log after a failed job and allows retrying', async () => {
    const user = userEvent.setup();
    const { onEnqueue } = renderItem({
      job: job({
        status: 'error',
        error: 'yt-dlp exited with code 1',
        log: ['ERROR: unavailable'],
      }),
    });

    expect(screen.getByText('Błąd')).toHaveAttribute('title', 'yt-dlp exited with code 1');
    expect(screen.getByText('Błąd: yt-dlp exited with code 1')).toBeInTheDocument();
    expect(screen.getByText('ERROR: unavailable')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Pobierz' }));
    expect(onEnqueue).toHaveBeenCalledWith(video, 'download');
  });

  it('shows a done status without the log', () => {
    renderItem({ isDownloaded: true, job: job({ status: 'done', log: ['finished'] }) });

    expect(screen.getByText('Pobrano')).toBeInTheDocument();
    expect(screen.queryByText('finished')).toBeNull();
    expect(screen.getByRole('button', { name: 'Aktualizuj' })).toBeInTheDocument();
  });
});
