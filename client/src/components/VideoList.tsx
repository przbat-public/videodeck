import { VideoListItem } from '../types';
import VideoCard from './VideoCard';

interface VideoListProps {
  videos: VideoListItem[];
  searchQuery?: string;
}

export default function VideoList({ videos, searchQuery }: VideoListProps): JSX.Element {
  if (videos.length === 0) {
    return (
      <div className="video-list-empty">
        <p>No videos found. Try a different search query.</p>
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
};
