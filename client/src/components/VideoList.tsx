import type { VideoListItem } from '@videodeck/shared/api';
import type { JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from './ui/Button';
import VideoCard from './VideoCard';

interface VideoListProps {
  videos: VideoListItem[];
  searchQuery?: string | undefined;
  /** Rows the results window released from the front to keep the list bounded */
  droppedCount?: number | undefined;
  /** Runs the search again, so the first page replaces the released rows */
  onBackToTop?: (() => void) | undefined;
}

export default function VideoList({ videos, searchQuery, droppedCount = 0, onBackToTop }: VideoListProps): JSX.Element {
  const { t } = useTranslation();

  if (videos.length === 0) {
    return (
      <div className="video-list-empty">
        <p>{t('search.noResults')}</p>
      </div>
    );
  }

  return (
    <div className="video-list">
      {droppedCount > 0 && onBackToTop !== undefined && (
        // The released rows lived at the top of the list: the notice stands
        // where they were, so scrolling back up explains the gap.
        <div className="video-list-trimmed">
          <p>{t('search.trimmedNotice', { count: droppedCount })}</p>
          <Button size="small" onClick={onBackToTop}>
            {t('search.backToTop')}
          </Button>
        </div>
      )}
      {videos.map((video, index) => (
        <VideoCard
          key={video.videoId || `${video.folderPath}/${video.baseName}`}
          video={video}
          searchQuery={searchQuery}
          index={index}
        />
      ))}
    </div>
  );
}
