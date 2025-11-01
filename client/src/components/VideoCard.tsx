import { Link } from 'react-router-dom';
import { VideoInfo } from '../hooks/useVideoSearch';

interface VideoCardProps {
  video: VideoInfo;
}

export default function VideoCard({ video }: VideoCardProps) {
  const thumbnailUrl = `/api/videos/file/${encodeURIComponent(video.thumbnailPath)}`;
  const descriptionPreview = video.description.length > 200 
    ? video.description.substring(0, 200) + '...'
    : video.description;

  return (
    <Link to={`/video/${encodeURIComponent(video.baseName)}`} className="video-card-link">
      <div className="video-card">
        <div className="video-thumbnail">
          <img 
            src={thumbnailUrl} 
            alt={video.name}
            loading="lazy"
            onError={(e) => {
              // Fallback if thumbnail fails to load
              (e.target as HTMLImageElement).style.display = 'none';
            }}
          />
          <div className="play-overlay">
            <svg width="64" height="64" viewBox="0 0 24 24" fill="white">
              <path d="M8 5v14l11-7z"/>
            </svg>
          </div>
        </div>
        <div className="video-info">
          <h3 className="video-title">{video.name}</h3>
          <p className="video-description">{descriptionPreview}</p>
        </div>
      </div>
    </Link>
  );
}

