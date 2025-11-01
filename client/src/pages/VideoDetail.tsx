import { useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { VideoInfo } from '../hooks/useVideoSearch';

interface VideoDetails {
  title: string;
  description: string;
  uploadDate: string;
  duration: string;
  viewCount: number;
  likeCount: number;
  channel: string;
  comments: Array<{
    id?: string;
    author?: string;
    author_id?: string;
    text?: string;
    like_count?: number;
    timestamp?: number;
    time_parsed?: string;
  }>;
  commentCount: number;
}

export default function VideoDetail() {
  const { baseName } = useParams<{ baseName: string }>();
  const navigate = useNavigate();
  const [video, setVideo] = useState<VideoInfo | null>(null);
  const [details, setDetails] = useState<VideoDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!baseName) {
      setError('Invalid video ID');
      setLoading(false);
      return;
    }

    const fetchData = async () => {
      try {
        setLoading(true);
        setError(null);

        // Find video in list
        const listResponse = await fetch('/api/videos/list');
        if (!listResponse.ok) throw new Error('Failed to load videos');
        const listData = await listResponse.json();
        const foundVideo = listData.videos.find((v: VideoInfo) => v.baseName === decodeURIComponent(baseName));
        
        if (!foundVideo) {
          throw new Error('Video not found');
        }
        setVideo(foundVideo);

        // Load details (including comments)
        const detailsResponse = await fetch(`/api/videos/${encodeURIComponent(foundVideo.baseName)}/details`);
        if (!detailsResponse.ok) throw new Error('Failed to load video details');
        const detailsData = await detailsResponse.json();
        setDetails(detailsData.details);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'An error occurred');
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [baseName]);

  if (loading) {
    return (
      <div className="video-detail-page">
        <div className="loading">
          <p>Loading video...</p>
        </div>
      </div>
    );
  }

  if (error || !video) {
    return (
      <div className="video-detail-page">
        <div className="error-message">
          <p>Error: {error || 'Video not found'}</p>
          <Link to="/" className="back-link">← Back to search</Link>
        </div>
      </div>
    );
  }

  const videoUrl = `/api/videos/file/${encodeURIComponent(video.videoPath)}`;
  const formatDate = (dateStr: string) => {
    if (!dateStr || dateStr.length !== 8) return dateStr;
    return `${dateStr.substring(0, 4)}-${dateStr.substring(4, 6)}-${dateStr.substring(6, 8)}`;
  };

  return (
    <div className="video-detail-page">
      <div className="video-detail-header">
        <Link to="/" className="back-link">← Back to search</Link>
      </div>

      <div className="video-detail-container">
        <div className="video-detail-main">
          <div className="video-player-section">
            <video
              src={videoUrl}
              controls
              autoPlay
              className="video-player-full"
            >
              Your browser does not support the video tag.
            </video>
          </div>

          <div className="video-detail-info">
            <h1>{details?.title || video.name}</h1>
            
            {details && (
              <div className="video-meta">
                <span>{details.channel}</span>
                {details.viewCount > 0 && <span>{details.viewCount.toLocaleString()} views</span>}
                {details.likeCount > 0 && <span>{details.likeCount.toLocaleString()} likes</span>}
                {details.uploadDate && <span>{formatDate(details.uploadDate)}</span>}
                {details.duration && <span>{details.duration}</span>}
              </div>
            )}

            <div className="video-description-full">
              <h2>Description</h2>
              <p>{details?.description || video.description}</p>
            </div>
          </div>
        </div>

        <div className="video-comments-section">
          <h2>Comments {details?.commentCount ? `(${details.commentCount})` : ''}</h2>
          
          {details?.comments && details.comments.length > 0 ? (
            <div className="comments-list">
              {details.comments.map((comment, index) => (
                <div key={comment.id || index} className="comment-item">
                  <div className="comment-header">
                    <strong>{comment.author || 'Anonymous'}</strong>
                    {comment.like_count !== undefined && comment.like_count > 0 && (
                      <span className="comment-likes">{comment.like_count} likes</span>
                    )}
                  </div>
                  <p className="comment-text">{comment.text || ''}</p>
                  {comment.time_parsed && (
                    <span className="comment-time">{comment.time_parsed}</span>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="no-comments">No comments available.</p>
          )}
        </div>
      </div>
    </div>
  );
}

