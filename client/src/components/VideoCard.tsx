import { Link } from 'react-router-dom';
import { VideoListItem } from '../types';

interface VideoCardProps {
  video: VideoListItem;
}

function formatVideoDate(dateStr?: string): string {
  if (!dateStr || dateStr.length !== 8) return '';
  return `${dateStr.substring(0, 4)}-${dateStr.substring(4, 6)}-${dateStr.substring(6, 8)}`;
}

function formatViewCount(viewCount?: number): string {
  if (!viewCount) return '';
  if (viewCount >= 1000000) {
    return `${(viewCount / 1000000).toFixed(1)}M`;
  }
  if (viewCount >= 1000) {
    return `${(viewCount / 1000).toFixed(1)}K`;
  }
  return viewCount.toString();
}

export default function VideoCard({ video }: VideoCardProps) {
  const thumbnailUrl = `/api/videos/file/${encodeURIComponent(video.thumbnailPath)}`;

  return (
    <Link
      to={`/video/${encodeURIComponent(video.baseName)}`}
      target="_blank"
      className="video-card-link"
    >
      <div className="video-card">
        <div className="video-thumbnail">
          <img
            src={thumbnailUrl}
            alt={video.title}
            loading="lazy"
            onError={(e) => {
              // Fallback if thumbnail fails to load
              (e.target as HTMLImageElement).style.display = 'none';
            }}
          />
          <div className="play-overlay">
            <svg width="64" height="64" viewBox="0 0 24 24" fill="white">
              <path d="M8 5v14l11-7z" />
            </svg>
          </div>
        </div>
        <div className="video-info">
          <div className="video-card-meta">
            {video.uploadDate && (
              <div className="video-card-date">{formatVideoDate(video.uploadDate)}</div>
            )}
            {video.viewCount !== undefined && (
              <div className="video-card-views">{formatViewCount(video.viewCount)}</div>
            )}
          </div>
          <h3 className="video-title">{video.title}</h3>
        </div>
      </div>
    </Link>
  );
}
