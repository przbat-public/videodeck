import { VideoInfo } from '../hooks/useVideoSearch';

interface VideoPlayerProps {
  video: VideoInfo | null;
  onClose: () => void;
}

export default function VideoPlayer({ video, onClose }: VideoPlayerProps) {
  if (!video) return null;

  const videoUrl = `/api/videos/file/${encodeURIComponent(video.videoPath)}`;

  return (
    <div className="video-player-overlay" onClick={onClose}>
      <div className="video-player-container" onClick={(e) => e.stopPropagation()}>
        <button className="video-player-close" onClick={onClose}>×</button>
        <video
          src={videoUrl}
          controls
          autoPlay
          className="video-player"
        >
          Your browser does not support the video tag.
        </video>
        <div className="video-player-info">
          <h2>{video.name}</h2>
          <p>{video.description}</p>
        </div>
      </div>
    </div>
  );
}

