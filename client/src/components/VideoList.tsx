import type { VideoListItem } from '@shared/api';
import VideoCard from './VideoCard';

interface VideoListProps {
  videos: VideoListItem[];
  searchQuery?: string | undefined;
}

export default function VideoList({ videos, searchQuery }: VideoListProps): JSX.Element {
  if (videos.length === 0) {
    return (
      <div className="video-list-empty">
        <p>Brak filmów. Spróbuj innego zapytania.</p>
      </div>
    );
  }

  return (
    <div className="video-list">
      {videos.map((video) => (
        <VideoCard key={video.baseName} video={video} searchQuery={searchQuery} />
      ))}
    </div>
  );
}
