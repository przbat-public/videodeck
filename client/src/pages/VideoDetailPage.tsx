import type { JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router-dom';
import { MAIN_CONTENT_ID } from '../components/AppLayout';
import { Button } from '../components/ui/Button';
import { ErrorMessage } from '../components/ui/ErrorMessage';
import { Loading } from '../components/ui/Loading';
import VideoComments from '../components/VideoComments';
import VideoSummary from '../components/VideoSummary';
import { usePageFocus } from '../hooks/usePageFocus';
import { useVideoDetail } from '../hooks/useVideoDetail';
import { formatUploadDate } from '../utils/videoDates';

export default function VideoDetailPage(): JSX.Element {
  const { videoId } = useParams<{ videoId: string }>();
  const { state, reload } = useVideoDetail(videoId);
  const { t, i18n } = useTranslation();
  // One landmark for every state of the page: the loading and error screens
  // used to render outside any landmark, and nothing moved focus, so a failed
  // route left the user at the top of an unchanged-looking document.
  const mainRef = usePageFocus<HTMLElement>();

  if (state.loading) {
    return (
      <main id={MAIN_CONTENT_ID} className="video-detail-page" ref={mainRef} tabIndex={-1}>
        {/* React 19 hoists the title into <head>; every state of the route
            names the tab, so none of them leaves the previous page's title
            standing. */}
        <title>{t('pageTitle.videoLoading')}</title>
        <Loading message={t('video.loading')} />
      </main>
    );
  }

  if (state.error || !state.details) {
    return (
      <main id={MAIN_CONTENT_ID} className="video-detail-page" ref={mainRef} tabIndex={-1}>
        <title>{t('pageTitle.videoError')}</title>
        <div className="page-error">
          <ErrorMessage>{t('app.error', { message: state.error || t('video.notFound') })}</ErrorMessage>
          <Button onClick={reload}>{t('app.retry')}</Button>
        </div>
      </main>
    );
  }

  const folderQuery = state.details.folderPath ? `?folder=${encodeURIComponent(state.details.folderPath)}` : '';
  const videoUrl = `/api/videos/file/${encodeURIComponent(state.details.videoPath)}${folderQuery}`;
  const posterUrl = `/api/videos/file/${encodeURIComponent(state.details.thumbnailPath)}${folderQuery}`;
  const subtitleUrl = (subtitlePath: string) => `/api/videos/file/${encodeURIComponent(subtitlePath)}${folderQuery}`;

  return (
    <main id={MAIN_CONTENT_ID} className="video-detail-page" ref={mainRef} tabIndex={-1}>
      <title>{t('pageTitle.video', { title: state.details.title })}</title>
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
    </main>
  );
}
