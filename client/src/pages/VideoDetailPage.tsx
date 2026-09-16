import type { JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { ErrorMessage } from '../components/ui/ErrorMessage';
import { Loading } from '../components/ui/Loading';
import VideoComments from '../components/VideoComments';
import VideoSummary from '../components/VideoSummary';
import { useVideoDetail } from '../hooks/useVideoDetail';
import { formatUploadDate } from '../utils/videoDates';

export default function VideoDetailPage(): JSX.Element {
  const { videoId } = useParams<{ videoId: string }>();
  const { state } = useVideoDetail(videoId);
  const { t, i18n } = useTranslation();

  if (state.loading) {
    return (
      <div className="video-detail-page">
        <Loading message={t('video.loading')} />
      </div>
    );
  }

  if (state.error || !state.details) {
    return (
      <div className="video-detail-page">
        <ErrorMessage>{t('app.error', { message: state.error || t('video.notFound') })}</ErrorMessage>
        <Link to="/" className="back-link">
          {t('video.back')}
        </Link>
      </div>
    );
  }

  const folderQuery = state.details.folderPath ? `?folder=${encodeURIComponent(state.details.folderPath)}` : '';
  const videoUrl = `/api/videos/file/${encodeURIComponent(state.details.videoPath)}${folderQuery}`;
  const posterUrl = `/api/videos/file/${encodeURIComponent(state.details.thumbnailPath)}${folderQuery}`;
  const subtitleUrl = (subtitlePath: string) => `/api/videos/file/${encodeURIComponent(subtitlePath)}${folderQuery}`;

  return (
    <div className="video-detail-page">
      <div className="video-detail-header">
        <Link to="/" className="back-link">
          {t('video.back')}
        </Link>
      </div>

      <div className="video-detail-container">
        <div className="video-detail-main">
          <div className="video-player-section">
            {/* Native HTML5 video: the files are plain mp4s and the server
                supports Range requests — no react-player dependency needed.
                The poster is the downloaded thumbnail, served by the same
                endpoint as the video file. */}
            {/* biome-ignore lint/a11y/useMediaCaption: subtitle tracks are injected dynamically from the API */}
            <video src={videoUrl} poster={posterUrl} controls className="video-player-full" data-testid="video-player">
              {state.details.subtitles.map((subtitle) => (
                <track
                  key={subtitle.path}
                  kind="subtitles"
                  src={subtitleUrl(subtitle.path)}
                  srcLang={subtitle.lang ?? 'und'}
                  label={
                    subtitle.lang
                      ? (t(`subtitleLanguages.${subtitle.lang}`, {
                          defaultValue: subtitle.lang,
                        }) as string)
                      : t('subtitleLanguages.generic')
                  }
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
                  <span>
                    {t('video.views', {
                      count: state.details.viewCount.toLocaleString(i18n.language),
                    })}
                  </span>
                )}
                {state.details.likeCount > 0 && (
                  <span>
                    {t('video.likes', {
                      count: state.details.likeCount.toLocaleString(i18n.language),
                    })}
                  </span>
                )}
                {state.details.uploadDate && <span>{formatUploadDate(state.details.uploadDate)}</span>}
              </div>
            )}
          </div>
        </div>

        <VideoSummary
          key={`summary-${videoId}-${state.details?.subtitlePath}`}
          baseName={videoId}
          subtitlePath={state.details?.subtitlePath}
        />

        <div className="video-description-full">
          <h2>{t('video.description')}</h2>
          <p>{state.details?.description}</p>
        </div>

        <VideoComments
          key={`comments-${videoId}-${state.details?.subtitlePath}`}
          videoId={videoId ?? ''}
          comments={state.details.comments || []}
          commentCount={state.details.commentCount}
        />
      </div>
    </div>
  );
}
