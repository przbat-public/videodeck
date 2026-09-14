import { useParams, Link } from 'react-router-dom';

import VideoSummary from '../components/VideoSummary';
import VideoComments from '../components/VideoComments';
import { useVideoDetail } from '../hooks/useVideoDetail';

export default function VideoDetailPage(): JSX.Element {
  const { videoId } = useParams<{ videoId: string }>();
  const { state } = useVideoDetail(videoId);

  if (state.loading) {
    return (
      <div className="video-detail-page">
        <div className="loading">
          <p>Ładowanie filmu...</p>
        </div>
      </div>
    );
  }

  if (state.error || !state.details) {
    return (
      <div className="video-detail-page">
        <div className="error-message">
          <p>Błąd: {state.error || 'Nie znaleziono filmu'}</p>
          <Link to="/videos" className="back-link">
            ← Wróć do wyszukiwania
          </Link>
        </div>
      </div>
    );
  }

  const folderQuery = state.details.folderPath
    ? `?folder=${encodeURIComponent(state.details.folderPath)}`
    : '';
  const videoUrl = `/api/videos/file/${encodeURIComponent(state.details.videoPath)}${folderQuery}`;

  const formatDate = (dateStr: string): string => {
    if (!dateStr || dateStr.length !== 8) return dateStr;
    return `${dateStr.substring(0, 4)}-${dateStr.substring(4, 6)}-${dateStr.substring(6, 8)}`;
  };

  return (
    <div className="video-detail-page">
      <div className="video-detail-header">
        <Link to="/videos" className="back-link">
          ← Wróć do wyszukiwania
        </Link>
      </div>

      <div className="video-detail-container">
        <div className="video-detail-main">
          <div className="video-player-section">
            {/* Native HTML5 video: the files are plain mp4s and the server
                supports Range requests — no react-player dependency needed */}
            <video
              src={videoUrl}
              controls
              className="video-player-full"
              data-testid="video-player"
            />
          </div>

          <div className="video-detail-info">
            <h1>{state.details?.title}</h1>

            {state.details && (
              <div className="video-meta">
                {state.details.viewCount > 0 && (
                  <span>{state.details.viewCount.toLocaleString('pl-PL')} wyświetleń</span>
                )}
                {state.details.likeCount > 0 && (
                  <span>{state.details.likeCount.toLocaleString('pl-PL')} polubień</span>
                )}
                {state.details.uploadDate && <span>{formatDate(state.details.uploadDate)}</span>}
              </div>
            )}
          </div>
        </div>

        <VideoSummary
          key={`${videoId}-${state.details?.subtitlePath}`}
          baseName={videoId}
          subtitlePath={state.details?.subtitlePath}
        />

        <div className="video-description-full">
          <h2>Oryginalny opis</h2>
          <p>{state.details?.description}</p>
        </div>

        <VideoComments
          comments={state.details.comments || []}
          commentCount={state.details.commentCount}
        />
      </div>
    </div>
  );
}
