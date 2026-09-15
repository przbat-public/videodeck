import type { VideoListItem } from '@videodeck/shared/api';
import type { JSX } from 'react';
import React, { memo } from 'react';
import { Link } from 'react-router-dom';

interface VideoCardProps {
  video: VideoListItem;
  searchQuery?: string | undefined;
  /** Position in the result list: the first rows are the LCP, keep them eager */
  index?: number | undefined;
}

const formatVideoDate = (dateStr?: string): string => {
  if (dateStr?.length !== 8) return '';
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

/**
 * Stable keys for fragments of a split string: the content plus its
 * occurrence count (a phrase can match twice, and plain parts can repeat).
 * The split produces the same array on every render, so these keys stay
 * stable across re-renders and are unique among siblings.
 */
const keyedParts = (parts: string[]): Array<{ part: string; key: string }> => {
  const occurrences = new Map<string, number>();
  return parts.map((part) => {
    const occurrence = occurrences.get(part) ?? 0;
    occurrences.set(part, occurrence + 1);
    return { part, key: occurrence === 0 ? part : `${part}-${occurrence}` };
  });
};

const highlightText = (text: string, query?: string): React.ReactNode => {
  if (!query?.trim()) {
    return text;
  }

  const searchTerm = query.trim();
  const escapedTerm = searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(${escapedTerm})`, 'gi');
  const parts = text.split(regex);

  return keyedParts(parts).map(({ part, key }) =>
    part.toLowerCase() === searchTerm.toLowerCase() ? (
      <mark key={key} className="search-highlight">
        {part}
      </mark>
    ) : (
      <React.Fragment key={key}>{part}</React.Fragment>
    ),
  );
};

/**
 * A server-side highlight fragment: Elasticsearch wraps matches in \u0001…
 * \u0002 control chars, so odd parts are the matches.
 */
const HIGHLIGHT_MARK_RE = new RegExp(`[${String.fromCharCode(1)}${String.fromCharCode(2)}]`);

const renderMarkedFragment = (fragment: string): React.ReactNode => {
  const parts = fragment.split(HIGHLIGHT_MARK_RE);
  return keyedParts(parts).map(({ part, key }, index) =>
    index % 2 === 1 ? (
      <mark key={key} className="search-highlight">
        {part}
      </mark>
    ) : (
      <React.Fragment key={key}>{part}</React.Fragment>
    ),
  );
};

function VideoCardInner({ video, searchQuery, index }: VideoCardProps): JSX.Element {
  const thumbnailUrl = `/api/videos/file/${encodeURIComponent(video.thumbnailPath)}?folder=${encodeURIComponent(video.folderPath)}`;

  const videoIdentifier = video.videoId || video.baseName;
  const serverTitle = video.highlights?.title?.[0];
  const serverSnippet = video.highlights?.description?.[0] ?? video.highlights?.snippet?.[0];

  return (
    <Link to={`/video/${encodeURIComponent(videoIdentifier)}`} target="_blank" className="video-card-link">
      <div className="video-card">
        <div className="video-thumbnail">
          <img
            src={thumbnailUrl}
            alt={video.title}
            // The first visible cards are the LCP: keep them eager (the top
            // one with high fetch priority), lazy-load everything below the
            // fold, decode every thumbnail off the main thread.
            loading={index !== undefined && index < 4 ? 'eager' : 'lazy'}
            decoding="async"
            fetchPriority={index === 0 ? 'high' : undefined}
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = 'none';
            }}
          />
          <div className="play-overlay">
            <svg width="64" height="64" viewBox="0 0 24 24" fill="white">
              <title>Play</title>
              <path d="M8 5v14l11-7z" />
            </svg>
          </div>
        </div>
        <div className="video-info">
          {video.channelName && <div className="video-card-channel">{video.channelName}</div>}
          <div className="video-card-meta">
            {video.uploadDate && <div className="video-card-date">{formatVideoDate(video.uploadDate)}</div>}
            {video.viewCount !== undefined && (
              <div className="video-card-views">{formatViewCount(video.viewCount)}</div>
            )}
          </div>
          <h3 className="video-title">
            {serverTitle ? renderMarkedFragment(serverTitle) : highlightText(video.title, searchQuery)}
          </h3>
          {serverSnippet && <p className="video-card-snippet">{renderMarkedFragment(serverSnippet)}</p>}
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
