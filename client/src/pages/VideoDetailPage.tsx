import type { JSX } from 'react';
import { useParams, Link } from 'react-router-dom';

import VideoSummary from '../components/VideoSummary';
import VideoComments from '../components/VideoComments';
import { ErrorMessage } from '../components/ui/ErrorMessage';
import { Loading } from '../components/ui/Loading';
import { useVideoDetail } from '../hooks/useVideoDetail';
import { formatUploadDate } from '../utils/videoDates';

/** Polish names for the subtitle languages we download; others show the code */
const SUBTITLE_NAMES: Record<string, string> = {
  pl: 'Polski',
  en: 'Angielski',
  de: 'Niemiecki',
  fr: 'Francuski',
  es: 'Hiszpański',
};

export default function VideoDetailPage(): JSX.Element {
  const { videoId } = useParams<{ videoId: string }>();
  const { state } = useVideoDetail(videoId);

  if (state.loading) {
    return (
      <div className="video-detail-page">
        <Loading message="Ładowanie filmu..." />
      </div>
    );
  }

  if (state.error || !state.details) {
    return (
      <div className="video-detail-page">
        <ErrorMessage>Błąd: {state.error || 'Nie znaleziono filmu'}</ErrorMessage>
        <Link to="/videos" className="back-link">
          ← Wróć do wyszukiwania
        </Link>
      </div>
    );
  }

  const folderQuery = state.details.folderPath
    ? `?folder=${encodeURIComponent(state.details.folderPath)}`
    : '';
  const videoUrl = `/api/videos/file/${encodeURIComponent(state.details.videoPath)}${folderQuery}`;
  const subtitleUrl = (subtitlePath: string) =>
    `/api/videos/file/${encodeURIComponent(subtitlePath)}${folderQuery}`;

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
            <video src={videoUrl} controls className="video-player-full" data-testid="video-player">
              {state.details.subtitles.map((subtitle) => (
                <track
                  key={subtitle.path}
                  kind="subtitles"
                  src={subtitleUrl(subtitle.path)}
                  srcLang={subtitle.lang ?? 'und'}
                  label={SUBTITLE_NAMES[subtitle.lang ?? ''] ?? subtitle.lang ?? 'Napisy'}
                  default={subtitle.path === state.details?.subtitlePath}
                />
              ))}
            </video>
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
                {state.details.uploadDate && (
                  <span>{formatUploadDate(state.details.uploadDate)}</span>
                )}
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
          key={`${videoId}-${state.details?.subtitlePath}`}
          videoId={videoId ?? ''}
          comments={state.details.comments || []}
          commentCount={state.details.commentCount}
        />
      </div>
    </div>
  );
}
