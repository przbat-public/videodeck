import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import VideoList from './VideoList';
import { VideoListItem } from '../types';

const mockVideos: VideoListItem[] = [
  {
    baseName: '20231201_TestVideo1',
    title: 'Test Video 1',
    description: 'Description 1',
    videoPath: '20231201_TestVideo1.mp4',
    thumbnailPath: '20231201_TestVideo1.webp',
    uploadDate: '20231201',
  },
  {
    baseName: '20231115_TestVideo2',
    title: 'Test Video 2',
    description: 'Description 2',
    videoPath: '20231115_TestVideo2.mp4',
    thumbnailPath: '20231115_TestVideo2.webp',
    uploadDate: '20231115',
  },
];

const renderWithRouter = (component: React.ReactElement) => {
  return render(<BrowserRouter>{component}</BrowserRouter>);
};

describe('VideoList', () => {
  it('should render list of videos', () => {
    renderWithRouter(<VideoList videos={mockVideos} />);
    expect(screen.getByText('Test Video 1')).toBeInTheDocument();
    expect(screen.getByText('Test Video 2')).toBeInTheDocument();
  });

  it('should render empty state when no videos', () => {
    renderWithRouter(<VideoList videos={[]} />);
    expect(
      screen.getByText('No videos found. Try a different search query.')
    ).toBeInTheDocument();
  });

  it('should render correct number of video cards', () => {
    renderWithRouter(<VideoList videos={mockVideos} />);
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(2);
  });
});

