import type { JSX } from 'react';
import { useTranslation } from 'react-i18next';
import type { VideoListItem } from '@shared/api';
import VideoCard from './VideoCard';

interface VideoListProps {
  videos: VideoListItem[];
  searchQuery?: string | undefined;
}

export default function VideoList({ videos, searchQuery }: VideoListProps): JSX.Element {
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
      {videos.map((video, index) => (
        <VideoCard key={video.baseName} video={video} searchQuery={searchQuery} index={index} />
      ))}
    </div>
  );
}
