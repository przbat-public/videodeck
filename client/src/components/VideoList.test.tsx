import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { VideoListItem } from '@videodeck/shared/api';
import { BrowserRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import i18n from '../i18n';
import VideoList from './VideoList';

const mockVideos: VideoListItem[] = [
  {
    baseName: '20231201_TestVideo1',
    title: 'Test Video 1',
    description: 'Description 1',
    videoPath: '20231201_TestVideo1.mp4',
    thumbnailPath: '20231201_TestVideo1.webp',
    folderPath: '/test/videos',
    uploadDate: '20231201',
    comments: [],
  },
  {
    baseName: '20231115_TestVideo2',
    title: 'Test Video 2',
    description: 'Description 2',
    videoPath: '20231115_TestVideo2.mp4',
    thumbnailPath: '20231115_TestVideo2.webp',
    folderPath: '/test/videos',
    uploadDate: '20231115',
    comments: [],
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
    expect(screen.getByText('Brak filmów. Spróbuj innego zapytania.')).toBeInTheDocument();
  });

  it('should render correct number of video cards', () => {
    renderWithRouter(<VideoList videos={mockVideos} />);
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(2);
  });

  it('offers no way back to the first page while the whole result set is on screen', () => {
    renderWithRouter(<VideoList videos={mockVideos} droppedCount={0} onBackToTop={() => undefined} />);

    expect(screen.queryByRole('button', { name: i18n.t('search.backToTop') })).toBeNull();
  });

  it('leaves the notice out when the list has no way back to offer', () => {
    renderWithRouter(<VideoList videos={mockVideos} droppedCount={250} />);

    expect(screen.queryByText(i18n.t('search.trimmedNotice', { count: 250 }))).toBeNull();
  });

  it('reports the released results and offers the way back to the first page', async () => {
    const user = userEvent.setup();
    const onBackToTop = vi.fn();
    renderWithRouter(<VideoList videos={mockVideos} droppedCount={250} onBackToTop={onBackToTop} />);

    expect(screen.getByText(i18n.t('search.trimmedNotice', { count: 250 }))).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: i18n.t('search.backToTop') }));

    expect(onBackToTop).toHaveBeenCalledTimes(1);
  });
});
