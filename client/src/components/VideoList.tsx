import { VideoInfo } from '../hooks/useVideoSearch';
import VideoCard from './VideoCard';

interface VideoListProps {
  videos: VideoInfo[];
}

export default function VideoList({ videos }: VideoListProps) {
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
        <VideoCard key={video.baseName} video={video} />
      ))}
    </div>
  );
}
