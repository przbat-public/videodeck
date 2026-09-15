import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockResponse } from '../test/fetchMock';
import { installFetchMock } from '../test/fetchMock';
import { toast } from '../test/toastMock';
import VideoSummary from './VideoSummary';

const json = (body: unknown, status = 200): MockResponse => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const fetchMock = installFetchMock();
const dismiss = vi.fn();
Object.assign(toast, { dismiss });

describe('VideoSummary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockReset();
  });

  it('renders nothing without a subtitle file', () => {
    const { container } = render(<VideoSummary baseName="video1" subtitlePath={undefined} />);

    expect(container.innerHTML).toBe('');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('renders the summary once it arrives', async () => {
    fetchMock.mockResolvedValueOnce(json({ summary: 'Video is about hedgehogs.' }));

    render(<VideoSummary baseName="video1" subtitlePath="video1.vtt" />);

    expect(await screen.findByText('Video is about hedgehogs.')).toBeInTheDocument();
    expect(screen.getByText('Streszczenie')).toBeInTheDocument();
    expect(screen.queryByText(/skróconych napisów/)).toBeNull();
  });

  it('shows a notice when the summary was truncated', async () => {
    fetchMock.mockResolvedValueOnce(json({ summary: 'Short summary.', truncated: true }));

    render(<VideoSummary baseName="video1" subtitlePath="video1.vtt" />);

    expect(await screen.findByText('Short summary.')).toBeInTheDocument();
    expect(
      screen.getByText(
        'To streszczenie powstało na podstawie skróconych napisów — tekst źródłowy był zbyt długi dla modelu.',
      ),
    ).toBeInTheDocument();
  });
});
