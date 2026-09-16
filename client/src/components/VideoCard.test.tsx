import { render, screen } from '@testing-library/react';
import type { VideoListItem } from '@videodeck/shared/api';
import { BrowserRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import VideoCard from './VideoCard';

const mockVideo: VideoListItem = {
  baseName: '20231201_TestVideo',
  title: 'Test Video Title',
  description: 'This is a test video description that might be quite long',
  videoPath: '20231201_TestVideo.mp4',
  thumbnailPath: '20231201_TestVideo.webp',
  folderPath: '/test/videos',
  uploadDate: '20231201',
  comments: [],
};

const renderWithRouter = (component: React.ReactElement) => {
  return render(<BrowserRouter>{component}</BrowserRouter>);
};

describe('VideoCard', () => {
  it('should render video title', () => {
    renderWithRouter(<VideoCard video={mockVideo} />);
    expect(screen.getByText('Test Video Title')).toBeInTheDocument();
  });

  it('should render formatted date', () => {
    renderWithRouter(<VideoCard video={mockVideo} />);
    expect(screen.getByText('2023-12-01')).toBeInTheDocument();
  });

  it.each([
    [1_500_000, '1.5M'],
    [12_345, '12.3K'],
    [999, '999'],
    [0, ''],
  ])('formats the view count %s as %s', (viewCount, expected) => {
    renderWithRouter(<VideoCard video={{ ...mockVideo, viewCount }} />);

    const views = document.querySelector('.video-card-views');
    expect(views?.textContent).toBe(expected);
  });

  it('renders no views element without a view count', () => {
    renderWithRouter(<VideoCard video={mockVideo} />);

    expect(document.querySelector('.video-card-views')).toBeNull();
  });

  it('should render thumbnail image with correct src', () => {
    renderWithRouter(<VideoCard video={mockVideo} />);
    const img = screen.getByAltText('Test Video Title');
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute(
      'src',
      `/api/videos/file/20231201_TestVideo.webp?folder=${encodeURIComponent(mockVideo.folderPath)}`,
    );
  });

  it('keeps the first thumbnail eager with high priority for the LCP', () => {
    renderWithRouter(<VideoCard video={mockVideo} index={0} />);
    const img = screen.getByAltText('Test Video Title');

    expect(img).toHaveAttribute('loading', 'eager');
    expect(img).toHaveAttribute('fetchpriority', 'high');
    expect(img).toHaveAttribute('decoding', 'async');
  });

  it('lazy-loads thumbnails below the first rows', () => {
    renderWithRouter(<VideoCard video={mockVideo} index={10} />);
    const img = screen.getByAltText('Test Video Title');

    expect(img).toHaveAttribute('loading', 'lazy');
    expect(img).not.toHaveAttribute('fetchpriority', 'high');
  });

  it('should have link to video detail page', () => {
    renderWithRouter(<VideoCard video={mockVideo} />);
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', '/video/20231201_TestVideo');
    expect(link).not.toHaveAttribute('target', '_blank');
  });

  it('should not render date if uploadDate is missing', () => {
    const { uploadDate: _uploadDate, ...videoWithoutDate } = mockVideo;
    renderWithRouter(<VideoCard video={videoWithoutDate} />);
    expect(screen.queryByText(/2023-12-01/)).not.toBeInTheDocument();
  });

  it('should handle thumbnail load error gracefully', () => {
    renderWithRouter(<VideoCard video={mockVideo} />);
    const img = screen.getByAltText('Test Video Title');

    // Simulate image error
    const errorEvent = new Event('error');
    img.dispatchEvent(errorEvent);

    // Image should be hidden (style.display = 'none')
    expect(img).toHaveStyle({ display: 'none' });
  });

  it('marks the query in the title when there are no server highlights', () => {
    renderWithRouter(<VideoCard video={mockVideo} searchQuery="Title" />);

    const mark = screen.getByText('Title');
    expect(mark.tagName).toBe('MARK');
    expect(mark).toHaveClass('search-highlight');
  });

  it('renders server-side highlight fragments as marks, title and snippet', () => {
    const withHighlights: VideoListItem = {
      ...mockVideo,
      highlights: {
        title: ['A \u0001robot\u0002 arm'],
        description: ['a long \u0001robot\u0002 description'],
      },
    };

    renderWithRouter(<VideoCard video={withHighlights} searchQuery="robot" />);

    const marks = screen.getAllByText('robot');
    expect(marks.length).toBe(2);
    expect(marks[0]).toHaveClass('search-highlight');
    expect(screen.getByText('a long ', { exact: false })).toBeInTheDocument();
  });
});
