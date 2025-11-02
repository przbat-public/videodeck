import { useParams, Link } from 'react-router-dom';
import ReactPlayer from 'react-player';
import CommentComponent from '../components/CommentComponent';
import { useVideoDetail } from '../hooks/useVideoDetail';

export default function VideoDetailPage() {
  const { baseName } = useParams<{ baseName: string }>();
  const { state } = useVideoDetail(baseName);

  if (state.loading) {
    return (
      <div className="video-detail-page">
        <div className="loading">
          <p>Loading video...</p>
        </div>
      </div>
    );
  }

  if (state.error || !state.details) {
    return (
      <div className="video-detail-page">
        <div className="error-message">
          <p>Error: {state.error || 'Video not found'}</p>
          <Link to="/" className="back-link">
            ← Back to search
          </Link>
        </div>
      </div>
    );
  }

  const videoUrl = `/api/videos/file/${encodeURIComponent(state.details.videoPath)}`;
  const formatDate = (dateStr: string) => {
    if (!dateStr || dateStr.length !== 8) return dateStr;
    return `${dateStr.substring(0, 4)}-${dateStr.substring(4, 6)}-${dateStr.substring(6, 8)}`;
  };

  return (
    <div className="video-detail-page">
      <div className="video-detail-header">
        <Link to="/" className="back-link">
          ← Back to search
        </Link>
      </div>

      <div className="video-detail-container">
        <div className="video-detail-main">
          <div className="video-player-section">
            <ReactPlayer
              src={videoUrl}
              controls
              playing
              width="100%"
              height="100%"
              className="video-player-full"
            />
          </div>

          <div className="video-detail-info">
            <h1>{state.details?.title}</h1>

            {state.details && (
              <div className="video-meta">
                {state.details.viewCount > 0 && (
                  <span>{state.details.viewCount.toLocaleString()} views</span>
                )}
                {state.details.likeCount > 0 && (
                  <span>{state.details.likeCount.toLocaleString()} likes</span>
                )}
                {state.details.uploadDate && <span>{formatDate(state.details.uploadDate)}</span>}
              </div>
            )}

            <div className="video-description-full">
              <h2>Description</h2>
              <p>{state.details?.description}</p>
            </div>
          </div>
        </div>

        <div className="video-comments-section">
          <h2>
            Comments {state.details?.commentCount ? `(${state.details.commentCount})` : ''}
          </h2>

          {state.details?.comments && state.details.comments.length > 0 ? (
            <div className="comments-list">
              {state.details.comments.map((comment, index) => (
                <CommentComponent key={comment.id || index} comment={comment} />
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
