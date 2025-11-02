import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { act } from 'react';
import userEvent from '@testing-library/user-event';
import CommentComponent from './CommentComponent';
import { Comment } from '../types';

describe('CommentComponent', () => {

  describe('Basic rendering', () => {
    it('should render comment text', () => {
      const comment: Comment = {
        id: '1',
        author: 'Test User',
        text: 'This is a test comment',
      };
      render(<CommentComponent comment={comment} />);
      expect(screen.getByText('This is a test comment')).toBeInTheDocument();
    });

    it('should render author name', () => {
      const comment: Comment = {
        id: '1',
        author: 'John Doe',
        text: 'Test comment',
      };
      render(<CommentComponent comment={comment} />);
      expect(screen.getByText('John Doe')).toBeInTheDocument();
    });

    it('should render Anonymous when author is missing', () => {
      const comment: Comment = {
        id: '1',
        text: 'Comment without author',
      };
      render(<CommentComponent comment={comment} />);
      expect(screen.getByText('Anonymous')).toBeInTheDocument();
    });

    it('should render like count when present and greater than 0', () => {
      const comment: Comment = {
        id: '1',
        author: 'Test User',
        text: 'Test comment',
        like_count: 42,
      };
      render(<CommentComponent comment={comment} />);
      expect(screen.getByText('42 likes')).toBeInTheDocument();
    });

    it('should not render like count when 0', () => {
      const comment: Comment = {
        id: '1',
        author: 'Test User',
        text: 'Test comment',
        like_count: 0,
      };
      render(<CommentComponent comment={comment} />);
      expect(screen.queryByText(/likes/)).not.toBeInTheDocument();
    });

    it('should not render like count when undefined', () => {
      const comment: Comment = {
        id: '1',
        author: 'Test User',
        text: 'Test comment',
      };
      render(<CommentComponent comment={comment} />);
      expect(screen.queryByText(/likes/)).not.toBeInTheDocument();
    });
  });

  describe('Long comments', () => {
    const createLongComment = (length: number): Comment => ({
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

    it('should show "Read more" button for long comments', () => {
      const comment = createLongComment(300);
      render(<CommentComponent comment={comment} />);
      
      expect(screen.getByRole('button', { name: /read more/i })).toBeInTheDocument();
    });

    it('should expand long comment when "Read more" is clicked', async () => {
      const user = userEvent.setup();
      const comment = createLongComment(300);
      render(<CommentComponent comment={comment} />);
      
      const readMoreBtn = screen.getByRole('button', { name: /read more/i });
      await act(async () => {
        await user.click(readMoreBtn);
      });
      
      await waitFor(() => {
        expect(screen.getByText(new RegExp(`^a{300}$`))).toBeInTheDocument();
      });
      expect(await screen.findByRole('button', { name: /show less/i })).toBeInTheDocument();
    });

    it('should collapse long comment when "Show less" is clicked', async () => {
      const user = userEvent.setup();
      const comment = createLongComment(300);
      render(<CommentComponent comment={comment} />);
      
      const readMoreBtn = screen.getByRole('button', { name: /read more/i });
      await act(async () => {
        await user.click(readMoreBtn);
      });
      
      const showLessBtn = await screen.findByRole('button', { name: /show less/i });
      await act(async () => {
        await user.click(showLessBtn);
      });
      
      await waitFor(() => {
        expect(screen.getByText(/^a{250}\.\.\.$/)).toBeInTheDocument();
      });
      expect(await screen.findByRole('button', { name: /read more/i })).toBeInTheDocument();
    });

    it('should not truncate short comments', () => {
      const comment = createLongComment(100);
      render(<CommentComponent comment={comment} />);
      
      expect(screen.getByText(new RegExp(`^a{100}$`))).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /read more/i })).not.toBeInTheDocument();
    });
  });

  describe('Date formatting', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should show "Today" for comments from today', () => {
      const now = new Date('2024-01-15T12:00:00Z');
      vi.setSystemTime(now);
      
      const timestamp = Math.floor(now.getTime() / 1000);
      const comment: Comment = {
        id: '1',
        author: 'Test User',
        text: 'Test comment',
        timestamp,
      };
      
      render(<CommentComponent comment={comment} />);
      expect(screen.getByText('Today')).toBeInTheDocument();
    });

    it('should show "Yesterday" for comments from yesterday', () => {
      const now = new Date('2024-01-15T12:00:00Z');
      vi.setSystemTime(now);
      
      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);
      const timestamp = Math.floor(yesterday.getTime() / 1000);
      
      const comment: Comment = {
        id: '1',
        author: 'Test User',
        text: 'Test comment',
        timestamp,
      };
      
      render(<CommentComponent comment={comment} />);
      expect(screen.getByText('Yesterday')).toBeInTheDocument();
    });

    it('should show "X days ago" for comments from last week', () => {
      const now = new Date('2024-01-15T12:00:00Z');
      vi.setSystemTime(now);
      
      const threeDaysAgo = new Date(now);
      threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
      const timestamp = Math.floor(threeDaysAgo.getTime() / 1000);
      
      const comment: Comment = {
        id: '1',
        author: 'Test User',
        text: 'Test comment',
        timestamp,
      };
      
      render(<CommentComponent comment={comment} />);
      expect(screen.getByText('3 days ago')).toBeInTheDocument();
    });

    it('should show "X weeks ago" for comments from last month', () => {
      const now = new Date('2024-01-15T12:00:00Z');
      vi.setSystemTime(now);
      
      const twoWeeksAgo = new Date(now);
      twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
      const timestamp = Math.floor(twoWeeksAgo.getTime() / 1000);
      
      const comment: Comment = {
        id: '1',
        author: 'Test User',
        text: 'Test comment',
        timestamp,
      };
      
      render(<CommentComponent comment={comment} />);
      expect(screen.getByText('2 weeks ago')).toBeInTheDocument();
    });

    it('should show "X months ago" for comments from last year', () => {
      const now = new Date('2024-01-15T12:00:00Z');
      vi.setSystemTime(now);
      
      const twoMonthsAgo = new Date(now);
      twoMonthsAgo.setMonth(twoMonthsAgo.getMonth() - 2);
      const timestamp = Math.floor(twoMonthsAgo.getTime() / 1000);
      
      const comment: Comment = {
        id: '1',
        author: 'Test User',
        text: 'Test comment',
        timestamp,
      };
      
      render(<CommentComponent comment={comment} />);
      expect(screen.getByText('2 months ago')).toBeInTheDocument();
    });

    it('should show full date for old comments', () => {
      const now = new Date('2024-01-15T12:00:00Z');
      vi.setSystemTime(now);
      
      const oldDate = new Date('2022-06-10T12:00:00Z');
      const timestamp = Math.floor(oldDate.getTime() / 1000);
      
      const comment: Comment = {
        id: '1',
        author: 'Test User',
        text: 'Test comment',
        timestamp,
      };
      
      render(<CommentComponent comment={comment} />);
      const timeElement = screen.getByText(/Jun/);
      expect(timeElement).toBeInTheDocument();
    });
  });

  describe('Time display fallbacks', () => {
    it('should use timestamp when available', () => {
      const now = new Date();
      vi.useFakeTimers();
      vi.setSystemTime(now);
      
      const timestamp = Math.floor(now.getTime() / 1000);
      const comment: Comment = {
        id: '1',
        author: 'Test User',
        text: 'Test comment',
        timestamp,
        time_parsed: 'Should not show',
        time_text: 'Should not show',
      };
      
      render(<CommentComponent comment={comment} />);
      expect(screen.getByText('Today')).toBeInTheDocument();
      expect(screen.queryByText('Should not show')).not.toBeInTheDocument();
      
      vi.useRealTimers();
    });

    it('should use time_parsed when timestamp is not available', () => {
      const comment: Comment = {
        id: '1',
        author: 'Test User',
        text: 'Test comment',
        time_parsed: '2 days ago',
      };
      
      render(<CommentComponent comment={comment} />);
      expect(screen.getByText('2 days ago')).toBeInTheDocument();
    });

    it('should use time_text when timestamp and time_parsed are not available', () => {
      const comment: Comment = {
        id: '1',
        author: 'Test User',
        text: 'Test comment',
        time_text: '3 hours ago',
      };
      
      render(<CommentComponent comment={comment} />);
      expect(screen.getByText('3 hours ago')).toBeInTheDocument();
    });

    it('should use _time_text when other time fields are not available', () => {
      const comment: Comment = {
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
      const comment: Comment = {
        id: '1',
        author: 'Test User',
        text: 'Test comment',
        replies: [
          { id: '2', text: 'Reply 1' },
          { id: '3', text: 'Reply 2' },
        ],
      };
      
      render(<CommentComponent comment={comment} />);
      expect(screen.getByText('(2 replies)')).toBeInTheDocument();
    });

    it('should show singular "reply" for one reply', () => {
      const comment: Comment = {
        id: '1',
        author: 'Test User',
        text: 'Test comment',
        replies: [{ id: '2', text: 'Reply 1' }],
      };
      
      render(<CommentComponent comment={comment} />);
      expect(screen.getByText('(1 reply)')).toBeInTheDocument();
    });

    it('should not show replies button when there are no replies', () => {
      const comment: Comment = {
        id: '1',
        author: 'Test User',
        text: 'Test comment',
        replies: [],
      };
      
      render(<CommentComponent comment={comment} />);
      expect(screen.queryByText(/reply|replies/)).not.toBeInTheDocument();
    });

    it('should not render replies by default', () => {
      const comment: Comment = {
        id: '1',
        author: 'Test User',
        text: 'Test comment',
        replies: [
          { id: '2', author: 'Reply Author', text: 'Reply text' },
        ],
      };
      
      render(<CommentComponent comment={comment} />);
      expect(screen.queryByText('Reply text')).not.toBeInTheDocument();
      expect(screen.queryByText('Reply Author')).not.toBeInTheDocument();
    });

    it('should show collapsed indicator (▶) by default', () => {
      const comment: Comment = {
        id: '1',
        author: 'Test User',
        text: 'Test comment',
        replies: [{ id: '2', text: 'Reply 1' }],
      };
      
      render(<CommentComponent comment={comment} />);
      const toggleBtn = screen.getByTitle('Show replies');
      expect(toggleBtn).toHaveTextContent('▶');
    });

    it('should expand replies when toggle is clicked', async () => {
      const user = userEvent.setup();
      const comment: Comment = {
        id: '1',
        author: 'Test User',
        text: 'Test comment',
        replies: [
          { id: '2', author: 'Reply Author', text: 'Reply text' },
        ],
      };
      
      render(<CommentComponent comment={comment} />);
      
      const toggleBtn = screen.getByTitle('Show replies');
      await act(async () => {
        await user.click(toggleBtn);
      });
      
      await waitFor(() => {
        expect(screen.getByText('Reply text')).toBeInTheDocument();
        expect(screen.getByText('Reply Author')).toBeInTheDocument();
        expect(toggleBtn).toHaveTextContent('▼');
        expect(toggleBtn).toHaveAttribute('title', 'Hide replies');
      });
    });

    it('should collapse replies when toggle is clicked again', async () => {
      const user = userEvent.setup();
      const comment: Comment = {
        id: '1',
        author: 'Test User',
        text: 'Test comment',
        replies: [
          { id: '2', author: 'Reply Author', text: 'Reply text' },
        ],
      };
      
      render(<CommentComponent comment={comment} />);
      
      const toggleBtn = screen.getByTitle('Show replies');
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
        expect(toggleBtn).toHaveAttribute('title', 'Show replies');
      });
    });

    it('should count direct replies only', () => {
      const comment: Comment = {
        id: '1',
        author: 'Test User',
        text: 'Test comment',
        replies: [
          { id: '2', text: 'Reply 1' },
          { id: '3', text: 'Reply 2' },
        ],
      };
      
      render(<CommentComponent comment={comment} />);
      expect(screen.getByText('(2 replies)')).toBeInTheDocument();
    });

  });

  describe('Depth and styling', () => {
    it('should apply correct margin for depth 0', () => {
      const comment: Comment = {
        id: '1',
        author: 'Test User',
        text: 'Test comment',
      };
      
      const { container } = render(<CommentComponent comment={comment} />);
      const commentItem = container.querySelector('.comment-item');
      expect(commentItem).toHaveStyle({ marginLeft: '0rem' });
      expect(commentItem).not.toHaveClass('comment-reply');
    });

    it('should apply correct margin for depth 1', () => {
      const comment: Comment = {
        id: '1',
        author: 'Test User',
        text: 'Test comment',
      };
      
      const { container } = render(<CommentComponent comment={comment} depth={1} />);
      const commentItem = container.querySelector('.comment-item');
      expect(commentItem).toHaveStyle({ marginLeft: '1.5rem' });
      expect(commentItem).toHaveClass('comment-reply');
    });

    it('should apply correct margin for depth 2', () => {
      const comment: Comment = {
        id: '1',
        author: 'Test User',
        text: 'Test comment',
      };
      
      const { container } = render(<CommentComponent comment={comment} depth={2} />);
      const commentItem = container.querySelector('.comment-item');
      expect(commentItem).toHaveStyle({ marginLeft: '3rem' });
      expect(commentItem).toHaveClass('comment-reply');
    });
  });

  describe('Edge cases', () => {
    it('should handle empty text', () => {
      const comment: Comment = {
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
      const comment: Comment = {
        id: '1',
        author: 'Test User',
        text: 'Test comment',
        replies: [
          { text: 'Reply without id' },
        ],
      };
      
      render(<CommentComponent comment={comment} />);
      
      const toggleBtn = screen.getByTitle('Show replies');
      await act(async () => {
        await user.click(toggleBtn);
      });
      
      await waitFor(() => {
        expect(screen.getByText('Reply without id')).toBeInTheDocument();
      });
    });

    it('should handle comment with only replies array defined but empty', () => {
      const comment: Comment = {
        id: '1',
        author: 'Test User',
        text: 'Test comment',
        replies: [],
      };
      
      render(<CommentComponent comment={comment} />);
      expect(screen.queryByText(/reply|replies/)).not.toBeInTheDocument();
    });
  });
});

