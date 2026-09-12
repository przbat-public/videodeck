import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import VideoCard from './VideoCard';
import type { VideoListItem } from '@shared/api';

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

  it('should render thumbnail image with correct src', () => {
    renderWithRouter(<VideoCard video={mockVideo} />);
    const img = screen.getByAltText('Test Video Title');
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute(
      'src',
      `/api/videos/file/20231201_TestVideo.webp?folder=${encodeURIComponent(mockVideo.folderPath)}`
    );
  });

  it('should have link to video detail page', () => {
    renderWithRouter(<VideoCard video={mockVideo} />);
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', '/video/20231201_TestVideo');
    expect(link).toHaveAttribute('target', '_blank');
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
});
