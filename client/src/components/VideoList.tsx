import { VideoInfo } from '../hooks/useVideoSearch';
import VideoCard from './VideoCard';

interface VideoListProps {
  videos: VideoInfo[];
  onPlay: (video: VideoInfo) => void;
}

export default function VideoList({ videos, onPlay }: VideoListProps) {
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
        <VideoCard key={video.baseName} video={video} onPlay={onPlay} />
      ))}
    </div>
  );
}

