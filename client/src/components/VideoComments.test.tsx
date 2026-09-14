import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { CommentWithReplies } from '@shared/api';
import VideoComments from './VideoComments';
import { installFetchMock } from '../test/fetchMock';
import type { MockResponse } from '../test/fetchMock';

const comment = (id: string): CommentWithReplies => ({ id, text: `Comment ${id}` });

const json = (body: unknown, status = 200): MockResponse => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const fetchMock = installFetchMock();

describe('VideoComments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockReset();
  });

  it('renders nothing without comments', () => {
    const { container } = render(<VideoComments videoId="v1" comments={[]} commentCount={0} />);

    expect(container.innerHTML).toBe('');
  });

  it('renders the first page and offers more when the count is larger', async () => {
    render(<VideoComments videoId="v1" comments={[comment('c1')]} commentCount={3} />);

    expect(screen.getByText('Komentarze (3)')).toBeInTheDocument();
    expect(screen.getByText('Comment c1')).toBeInTheDocument();

    fetchMock.mockResolvedValueOnce(
      json({ comments: [comment('c2'), comment('c3')], totalCount: 3, offset: 1 })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Pokaż więcej komentarzy (1/3)' }));

    await waitFor(() => expect(screen.getByText('Comment c3')).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith('/api/videos/v1/comments?offset=1&limit=50');
    expect(screen.queryByRole('button', { name: /Pokaż więcej/ })).toBeNull();
  });

  it('shows an error when the next page fails', async () => {
    render(<VideoComments videoId="v1" comments={[comment('c1')]} commentCount={5} />);

    fetchMock.mockResolvedValueOnce(json({ error: 'boom' }, 500));
    fireEvent.click(screen.getByRole('button', { name: 'Pokaż więcej komentarzy (1/5)' }));

    expect(
      await screen.findByText('Nie udało się załadować kolejnych komentarzy.')
    ).toBeInTheDocument();
  });

  it('does not offer more when everything is already shown', () => {
    render(<VideoComments videoId="v1" comments={[comment('c1')]} commentCount={1} />);

    expect(screen.queryByRole('button', { name: /Pokaż więcej/ })).toBeNull();
  });
});
