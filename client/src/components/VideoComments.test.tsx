import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
    const user = userEvent.setup();
    render(<VideoComments videoId="v1" comments={[comment('c1')]} commentCount={3} />);

    expect(screen.getByText('Komentarze (3)')).toBeInTheDocument();
    expect(screen.getByText('Comment c1')).toBeInTheDocument();

    fetchMock.mockResolvedValueOnce(
      json({ comments: [comment('c2'), comment('c3')], totalCount: 3, offset: 1 })
    );
    await user.click(screen.getByRole('button', { name: 'Pokaż więcej komentarzy (1/3)' }));

    await waitFor(() => expect(screen.getByText('Comment c3')).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/videos/v1/comments?offset=1&limit=50',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(screen.queryByRole('button', { name: /Pokaż więcej/ })).toBeNull();
  });

  it('shows an error when the next page fails', async () => {
    const user = userEvent.setup();
    render(<VideoComments videoId="v1" comments={[comment('c1')]} commentCount={5} />);

    fetchMock.mockResolvedValueOnce(json({ error: 'boom' }, 500));
    await user.click(screen.getByRole('button', { name: 'Pokaż więcej komentarzy (1/5)' }));

    expect(
      await screen.findByText('Nie udało się załadować kolejnych komentarzy.')
    ).toBeInTheDocument();
  });

  it('does not offer more when everything is already shown', () => {
    render(<VideoComments videoId="v1" comments={[comment('c1')]} commentCount={1} />);

    expect(screen.queryByRole('button', { name: /Pokaż więcej/ })).toBeNull();
  });

  it('ignores a second click while a page is already loading', async () => {
    const user = userEvent.setup();
    render(<VideoComments videoId="v1" comments={[comment('c1')]} commentCount={5} />);

    let resolveFetch: (response: MockResponse) => void = () => {};
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        })
    );

    const button = screen.getByRole('button', { name: 'Pokaż więcej komentarzy (1/5)' });
    await user.click(button);
    // the first click disables the button while the page loads
    await user.click(button);

    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveFetch(json({ comments: [comment('c2')], totalCount: 5, offset: 1 }));
    await waitFor(() => expect(screen.getByText('Comment c2')).toBeInTheDocument());
  });

  it('aborts the pending page when the component unmounts', async () => {
    const user = userEvent.setup();
    const { unmount } = render(
      <VideoComments videoId="v1" comments={[comment('c1')]} commentCount={5} />
    );

    // A page that never resolves: the request must still be in flight when
    // the component goes away, so the abort is observable.
    fetchMock.mockImplementationOnce(() => new Promise(() => {}));
    await user.click(screen.getByRole('button', { name: 'Pokaż więcej komentarzy (1/5)' }));
    unmount();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, options] = fetchMock.mock.calls[0] as [string, { signal: AbortSignal }];
    expect(options.signal.aborted).toBe(true);
  });
});
