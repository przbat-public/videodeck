import { memo } from 'react';
import type { JSX } from 'react';
import { Link } from 'react-router-dom';
import type { VideoListItem } from '@shared/api';
import React from 'react';

interface VideoCardProps {
  video: VideoListItem;
  searchQuery?: string | undefined;
}

const formatVideoDate = (dateStr?: string): string => {
  if (!dateStr || dateStr.length !== 8) return '';
  return `${dateStr.substring(0, 4)}-${dateStr.substring(4, 6)}-${dateStr.substring(6, 8)}`;
};

const formatViewCount = (viewCount?: number): string => {
  if (!viewCount) return '';
  if (viewCount >= 1000000) {
    return `${(viewCount / 1000000).toFixed(1)}M`;
  }
  if (viewCount >= 1000) {
    return `${(viewCount / 1000).toFixed(1)}K`;
  }
  return viewCount.toString();
};

const highlightText = (text: string, query?: string): React.ReactNode => {
  if (!query || !query.trim()) {
    return text;
  }

  const searchTerm = query.trim();
  const escapedTerm = searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(${escapedTerm})`, 'gi');
  const parts = text.split(regex);

  // Position is a stable identity here: the array is rebuilt from the same
  // split on every render and React never reorders it.
  return parts.map((part, index) =>
    part.toLowerCase() === searchTerm.toLowerCase() ? (
      // eslint-disable-next-line @eslint-react/no-array-index-key
      <mark key={index} className="search-highlight">
        {part}
      </mark>
    ) : (
      // eslint-disable-next-line @eslint-react/no-array-index-key
      <React.Fragment key={index}>{part}</React.Fragment>
    )
  );
};

function VideoCardInner({ video, searchQuery }: VideoCardProps): JSX.Element {
  const thumbnailUrl = `/api/videos/file/${encodeURIComponent(video.thumbnailPath)}?folder=${encodeURIComponent(video.folderPath)}`;

  const videoIdentifier = video.videoId || video.baseName;

  return (
    <Link
      to={`/video/${encodeURIComponent(videoIdentifier)}`}
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
          {video.channelName && <div className="video-card-channel">{video.channelName}</div>}
          <div className="video-card-meta">
            {video.uploadDate && (
              <div className="video-card-date">{formatVideoDate(video.uploadDate)}</div>
            )}
            {video.viewCount !== undefined && (
              <div className="video-card-views">{formatViewCount(video.viewCount)}</div>
            )}
          </div>
          <h3 className="video-title">{highlightText(video.title, searchQuery)}</h3>
        </div>
      </div>
    </Link>
  );
}

/**
 * Memoized: the search page renders up to 100 cards and every state change
 * (loading, load-more) re-renders the list — the video objects themselves
 * are stable, so the default shallow comparison skips unchanged cards.
 */
const VideoCard = memo(VideoCardInner);
export default VideoCard;
