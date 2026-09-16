import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CommentWithReplies } from '@videodeck/shared/api';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CommentComponent from './CommentComponent';

describe('CommentComponent', () => {
  describe('Basic rendering', () => {
    it('should render comment text', () => {
      const comment: CommentWithReplies = {
        id: '1',
        author: 'Test User',
        text: 'This is a test comment',
      };
      render(<CommentComponent comment={comment} />);
      expect(screen.getByText('This is a test comment')).toBeInTheDocument();
    });

    it('should render author name', () => {
      const comment: CommentWithReplies = {
        id: '1',
        author: 'John Doe',
        text: 'Test comment',
      };
      render(<CommentComponent comment={comment} />);
      expect(screen.getByText('John Doe')).toBeInTheDocument();
    });

    it('should render Anonymous when author is missing', () => {
      const comment: CommentWithReplies = {
        id: '1',
        text: 'Comment without author',
      };
      render(<CommentComponent comment={comment} />);
      expect(screen.getByText('Anonim')).toBeInTheDocument();
    });

    it('should render like count when present and greater than 0', () => {
      const comment: CommentWithReplies = {
        id: '1',
        author: 'Test User',
        text: 'Test comment',
        like_count: 42,
      };
      render(<CommentComponent comment={comment} />);
      expect(screen.getByText('42 polubienia')).toBeInTheDocument();
    });

    it('should not render like count when 0', () => {
      const comment: CommentWithReplies = {
        id: '1',
        author: 'Test User',
        text: 'Test comment',
        like_count: 0,
      };
      render(<CommentComponent comment={comment} />);
      expect(screen.queryByText(/polubień/)).not.toBeInTheDocument();
    });

    it('should not render like count when undefined', () => {
      const comment: CommentWithReplies = {
        id: '1',
        author: 'Test User',
        text: 'Test comment',
      };
      render(<CommentComponent comment={comment} />);
      expect(screen.queryByText(/polubień/)).not.toBeInTheDocument();
    });
  });

  describe('Long comments', () => {
    const createLongComment = (length: number): CommentWithReplies => ({
      id: '1',
      author: 'Test User',
      text: 'a'.repeat(length),
    });

    it('should truncate long comments', () => {
      const comment = createLongComment(300);
      render(<CommentComponent comment={comment} />);

      const commentText = screen.getByText(/^a{250}\.\.\.$/);
      expect(commentText).toBeInTheDocument();
    });

    it('shows the "Read more" (pl: "Czytaj więcej") button for long comments', () => {
      const comment = createLongComment(300);
      render(<CommentComponent comment={comment} />);

      expect(screen.getByRole('button', { name: /czytaj więcej/i })).toBeInTheDocument();
    });

    it('expands the long comment when "Read more" is clicked', async () => {
      const user = userEvent.setup();
      const comment = createLongComment(300);
      render(<CommentComponent comment={comment} />);

      const readMoreBtn = screen.getByRole('button', { name: /czytaj więcej/i });
      await act(async () => {
        await user.click(readMoreBtn);
      });

      await waitFor(() => {
        expect(screen.getByText(/^a{300}$/)).toBeInTheDocument();
      });
      expect(await screen.findByRole('button', { name: /zwiń/i })).toBeInTheDocument();
    });

    it('collapses the long comment when "Collapse" (pl: "Zwiń") is clicked', async () => {
      const user = userEvent.setup();
      const comment = createLongComment(300);
      render(<CommentComponent comment={comment} />);

      const readMoreBtn = screen.getByRole('button', { name: /czytaj więcej/i });
      await act(async () => {
        await user.click(readMoreBtn);
      });

      const showLessBtn = await screen.findByRole('button', { name: /zwiń/i });
      await act(async () => {
        await user.click(showLessBtn);
      });

      await waitFor(() => {
        expect(screen.getByText(/^a{250}\.\.\.$/)).toBeInTheDocument();
      });
      expect(await screen.findByRole('button', { name: /czytaj więcej/i })).toBeInTheDocument();
    });

    it('should not truncate short comments', () => {
      const comment = createLongComment(100);
      render(<CommentComponent comment={comment} />);

      expect(screen.getByText(/^a{100}$/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /czytaj więcej/i })).not.toBeInTheDocument();
    });
  });

  describe('Date formatting', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should show "Dzisiaj" for comments from today', () => {
      const now = new Date('2024-01-15T12:00:00Z');
      vi.setSystemTime(now);

      const timestamp = Math.floor(now.getTime() / 1000);
      const comment: CommentWithReplies = {
        id: '1',
        author: 'Test User',
        text: 'Test comment',
        timestamp,
      };

      render(<CommentComponent comment={comment} />);
      expect(screen.getByText('Dzisiaj')).toBeInTheDocument();
    });

    it('should show "Wczoraj" for comments from yesterday', () => {
      const now = new Date('2024-01-15T12:00:00Z');
      vi.setSystemTime(now);

      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);
      const timestamp = Math.floor(yesterday.getTime() / 1000);

      const comment: CommentWithReplies = {
        id: '1',
        author: 'Test User',
        text: 'Test comment',
        timestamp,
      };

      render(<CommentComponent comment={comment} />);
      expect(screen.getByText('Wczoraj')).toBeInTheDocument();
    });

    it('should show "X dni temu" for comments from last week', () => {
      const now = new Date('2024-01-15T12:00:00Z');
      vi.setSystemTime(now);

      const threeDaysAgo = new Date(now);
      threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
      const timestamp = Math.floor(threeDaysAgo.getTime() / 1000);

      const comment: CommentWithReplies = {
        id: '1',
        author: 'Test User',
        text: 'Test comment',
        timestamp,
      };

      render(<CommentComponent comment={comment} />);
      expect(screen.getByText('3 dni temu')).toBeInTheDocument();
    });

    it('should show "X tygodni temu" for comments from last month', () => {
      const now = new Date('2024-01-15T12:00:00Z');
      vi.setSystemTime(now);

      const twoWeeksAgo = new Date(now);
      twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
      const timestamp = Math.floor(twoWeeksAgo.getTime() / 1000);

      const comment: CommentWithReplies = {
        id: '1',
        author: 'Test User',
        text: 'Test comment',
        timestamp,
      };

      render(<CommentComponent comment={comment} />);
      expect(screen.getByText('2 tygodnie temu')).toBeInTheDocument();
    });

    it('shows the Polish "X months ago" (pl: "X miesięcy temu") label for comments from last year', () => {
      const now = new Date('2024-01-15T12:00:00Z');
      vi.setSystemTime(now);

      const twoMonthsAgo = new Date(now);
      twoMonthsAgo.setMonth(twoMonthsAgo.getMonth() - 2);
      const timestamp = Math.floor(twoMonthsAgo.getTime() / 1000);

      const comment: CommentWithReplies = {
        id: '1',
        author: 'Test User',
        text: 'Test comment',
        timestamp,
      };

      render(<CommentComponent comment={comment} />);
      expect(screen.getByText('2 miesiące temu')).toBeInTheDocument();
    });

    it('should show full date for old comments', () => {
      const now = new Date('2024-01-15T12:00:00Z');
      vi.setSystemTime(now);

      const oldDate = new Date('2022-06-10T12:00:00Z');
      const timestamp = Math.floor(oldDate.getTime() / 1000);

      const comment: CommentWithReplies = {
        id: '1',
        author: 'Test User',
        text: 'Test comment',
        timestamp,
      };

      render(<CommentComponent comment={comment} />);
      const timeElement = screen.getByText(/cze/);
      expect(timeElement).toBeInTheDocument();
    });
  });

  describe('Time display fallbacks', () => {
    it('should use timestamp when available', () => {
      const now = new Date();
      vi.useFakeTimers();
      vi.setSystemTime(now);

      const timestamp = Math.floor(now.getTime() / 1000);
      const comment: CommentWithReplies = {
        id: '1',
        author: 'Test User',
        text: 'Test comment',
        timestamp,
        time_parsed: 'Should not show',
        time_text: 'Should not show',
      };

      render(<CommentComponent comment={comment} />);
      expect(screen.getByText('Dzisiaj')).toBeInTheDocument();
      expect(screen.queryByText('Should not show')).not.toBeInTheDocument();

      vi.useRealTimers();
    });

    it('should use time_parsed when timestamp is not available', () => {
      const comment: CommentWithReplies = {
        id: '1',
        author: 'Test User',
        text: 'Test comment',
        time_parsed: '2 days ago',
      };

      render(<CommentComponent comment={comment} />);
      expect(screen.getByText('2 days ago')).toBeInTheDocument();
    });

    it('should use time_text when timestamp and time_parsed are not available', () => {
      const comment: CommentWithReplies = {
        id: '1',
        author: 'Test User',
        text: 'Test comment',
        time_text: '3 hours ago',
      };

      render(<CommentComponent comment={comment} />);
      expect(screen.getByText('3 hours ago')).toBeInTheDocument();
    });

    it('should use _time_text when other time fields are not available', () => {
      const comment: CommentWithReplies = {
        id: '1',
        author: 'Test User',
        text: 'Test comment',
        _time_text: '5 minutes ago',
      };

      render(<CommentComponent comment={comment} />);
      expect(screen.getByText('5 minutes ago')).toBeInTheDocument();
    });
  });

  describe('Replies', () => {
    it('should show replies count button', () => {
      const comment: CommentWithReplies = {
        id: '1',
        author: 'Test User',
        text: 'Test comment',
        replies: [
          { id: '2', text: 'Reply 1' },
          { id: '3', text: 'Reply 2' },
        ],
      };

      render(<CommentComponent comment={comment} />);
      expect(screen.getByText('(2 odpowiedzi)')).toBeInTheDocument();
    });

    it('shows the singular Polish "reply" (pl: "odpowiedź") label for one reply', () => {
      const comment: CommentWithReplies = {
        id: '1',
        author: 'Test User',
        text: 'Test comment',
        replies: [{ id: '2', text: 'Reply 1' }],
      };

      render(<CommentComponent comment={comment} />);
      expect(screen.getByText('(1 odpowiedź)')).toBeInTheDocument();
    });

    it('should not show replies button when there are no replies', () => {
      const comment: CommentWithReplies = {
        id: '1',
        author: 'Test User',
        text: 'Test comment',
        replies: [],
      };

      render(<CommentComponent comment={comment} />);
      expect(screen.queryByText(/odpowiedź|odpowiedzi/)).not.toBeInTheDocument();
    });

    it('should not render replies by default', () => {
      const comment: CommentWithReplies = {
        id: '1',
        author: 'Test User',
        text: 'Test comment',
        replies: [{ id: '2', author: 'Reply Author', text: 'Reply text' }],
      };

      render(<CommentComponent comment={comment} />);
      expect(screen.queryByText('Reply text')).not.toBeInTheDocument();
      expect(screen.queryByText('Reply Author')).not.toBeInTheDocument();
    });

    it('should show collapsed indicator (▶) by default', () => {
      const comment: CommentWithReplies = {
        id: '1',
        author: 'Test User',
        text: 'Test comment',
        replies: [{ id: '2', text: 'Reply 1' }],
      };

      render(<CommentComponent comment={comment} />);
      const toggleBtn = screen.getByRole('button', { name: /▶/ });
      expect(toggleBtn).toHaveTextContent('▶');
    });

    it('should expand replies when toggle is clicked', async () => {
      const user = userEvent.setup();
      const comment: CommentWithReplies = {
        id: '1',
        author: 'Test User',
        text: 'Test comment',
        replies: [{ id: '2', author: 'Reply Author', text: 'Reply text' }],
      };

      render(<CommentComponent comment={comment} />);

      const toggleBtn = screen.getByRole('button', { name: /▶/ });
      await act(async () => {
        await user.click(toggleBtn);
      });

      await waitFor(() => {
        expect(screen.getByText('Reply text')).toBeInTheDocument();
        expect(screen.getByText('Reply Author')).toBeInTheDocument();
        expect(toggleBtn).toHaveTextContent('▼');
      });

      // The click itself closes the tooltip (Radix dismisses on trigger
      // click); leave and re-enter to open it with the new label.
      await user.unhover(toggleBtn);
      await user.hover(toggleBtn);
      expect(await screen.findByRole('tooltip', { name: 'Ukryj odpowiedzi' })).toBeInTheDocument();
    });

    it('should collapse replies when toggle is clicked again', async () => {
      const user = userEvent.setup();
      const comment: CommentWithReplies = {
        id: '1',
        author: 'Test User',
        text: 'Test comment',
        replies: [{ id: '2', author: 'Reply Author', text: 'Reply text' }],
      };

      render(<CommentComponent comment={comment} />);

      const toggleBtn = screen.getByRole('button', { name: /▶/ });
      await act(async () => {
        await user.click(toggleBtn);
      });

      await waitFor(() => {
        expect(screen.getByText('Reply text')).toBeInTheDocument();
      });

      await act(async () => {
        await user.click(toggleBtn);
      });

      await waitFor(() => {
        expect(screen.queryByText('Reply text')).not.toBeInTheDocument();
        expect(toggleBtn).toHaveTextContent('▶');
      });

      // The click itself closes the tooltip (Radix dismisses on trigger
      // click); leave and re-enter to open it with the new label.
      await user.unhover(toggleBtn);
      await user.hover(toggleBtn);
      expect(await screen.findByRole('tooltip', { name: 'Pokaż odpowiedzi' })).toBeInTheDocument();
    });

    it('should count direct replies only', () => {
      const comment: CommentWithReplies = {
        id: '1',
        author: 'Test User',
        text: 'Test comment',
        replies: [
          { id: '2', text: 'Reply 1' },
          { id: '3', text: 'Reply 2' },
        ],
      };

      render(<CommentComponent comment={comment} />);
      expect(screen.getByText('(2 odpowiedzi)')).toBeInTheDocument();
    });
  });

  describe('Depth and styling', () => {
    it('should apply correct margin for depth 0', () => {
      const comment: CommentWithReplies = {
        id: '1',
        author: 'Test User',
        text: 'Test comment',
      };

      const { container } = render(<CommentComponent comment={comment} />);
      const commentItem = container.querySelector<HTMLElement>('.comment-item');
      // Inline style, read straight from the element: jest-dom v7 checks the
      // COMPUTED style, where `0rem` collapses to `0px` in jsdom.
      expect(commentItem?.style.marginLeft).toBe('0rem');
      expect(commentItem).not.toHaveClass('comment-reply');
    });

    it('should apply correct margin for depth 1', () => {
      const comment: CommentWithReplies = {
        id: '1',
        author: 'Test User',
        text: 'Test comment',
      };

      const { container } = render(<CommentComponent comment={comment} depth={1} />);
      const commentItem = container.querySelector<HTMLElement>('.comment-item');
      expect(commentItem?.style.marginLeft).toBe('1.5rem');
      expect(commentItem).toHaveClass('comment-reply');
    });

    it('should apply correct margin for depth 2', () => {
      const comment: CommentWithReplies = {
        id: '1',
        author: 'Test User',
        text: 'Test comment',
      };

      const { container } = render(<CommentComponent comment={comment} depth={2} />);
      const commentItem = container.querySelector<HTMLElement>('.comment-item');
      expect(commentItem?.style.marginLeft).toBe('3rem');
      expect(commentItem).toHaveClass('comment-reply');
    });
  });

  describe('Edge cases', () => {
    it('should handle empty text', () => {
      const comment: CommentWithReplies = {
        id: '1',
        author: 'Test User',
        text: '',
      };

      const { container } = render(<CommentComponent comment={comment} />);
      const commentText = container.querySelector('.comment-text');
      expect(commentText).toBeInTheDocument();
      expect(commentText?.textContent).toBe('');
    });

    it('should handle missing id in replies', async () => {
      const user = userEvent.setup();
      const comment: CommentWithReplies = {
        id: '1',
        author: 'Test User',
        text: 'Test comment',
        replies: [{ text: 'Reply without id' }],
      };

      render(<CommentComponent comment={comment} />);

      const toggleBtn = screen.getByRole('button', { name: /▶/ });
      await act(async () => {
        await user.click(toggleBtn);
      });

      await waitFor(() => {
        expect(screen.getByText('Reply without id')).toBeInTheDocument();
      });
    });

    it('should handle comment with only replies array defined but empty', () => {
      const comment: CommentWithReplies = {
        id: '1',
        author: 'Test User',
        text: 'Test comment',
        replies: [],
      };

      render(<CommentComponent comment={comment} />);
      expect(screen.queryByText(/odpowiedź|odpowiedzi/)).not.toBeInTheDocument();
    });
  });
});
