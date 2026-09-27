import type { VideoDetails } from '@videodeck/shared/api';
import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router-dom';
import { MAIN_CONTENT_ID } from '../components/AppLayout';
import { Button } from '../components/ui/Button';
import { ErrorMessage } from '../components/ui/ErrorMessage';
import { Loading } from '../components/ui/Loading';
import VideoComments from '../components/VideoComments';
import VideoSummary from '../components/VideoSummary';
import { usePageFocus } from '../hooks/usePageFocus';
import { formatPlaybackTime, usePlaybackPosition } from '../hooks/usePlaybackPosition';
import { useVideoDetail } from '../hooks/useVideoDetail';
import { formatUploadDate } from '../utils/videoDates';

/** How far a media key without an offset of its own jumps */
const SEEK_STEP_SECONDS = 10;

/** One asset of a video through the file endpoint, with the folder it came from */
function assetUrl(path: string, folderPath: string | undefined): string {
  const folder = folderPath ? `?folder=${encodeURIComponent(folderPath)}` : '';
  return `/api/videos/file/${encodeURIComponent(path)}${folder}`;
}

/** Start playback, ignoring the rejection the autoplay policy can produce */
function playQuietly(player: HTMLVideoElement): void {
  // Browsers return a promise here that may reject; jsdom returns nothing.
  const started: Promise<void> | undefined = player.play();
  void started?.catch(() => undefined);
}

/**
 * Put the player at a position and start it. `currentTime` is the element's own
 * state, not React's: the page only holds the element, and moving it does not
 * re-render anything.
 */
function seekAndPlay(player: HTMLVideoElement, position: number): void {
  player.currentTime = position;
  playQuietly(player);
}

/** Seek by an offset, never past either end of the video */
function seekBy(player: HTMLVideoElement, offset: number): void {
  const target = Math.max(0, player.currentTime + offset);
  player.currentTime = Number.isFinite(player.duration) ? Math.min(target, player.duration) : target;
}

/**
 * Run a Media Session call whose support differs between browsers. Safari and
 * Firefox each leave out part of the action set, and asking for an action a
 * browser does not implement throws. Playback has to survive that, so every
 * call goes through here.
 */
function guardMediaSession(call: () => void): void {
  try {
    call();
  } catch {
    // Unsupported call: that control simply stays with the browser.
  }
}

/**
 * Hand the video to the OS media controls: the lock screen and the media keys
 * show the title, the channel and the poster, and their buttons drive this
 * player. Cleared on the way out, or the next route would keep announcing a
 * video that is no longer on screen.
 */
function useMediaSession(player: HTMLVideoElement | null, details: VideoDetails | null): void {
  const title = details?.title;
  const artist = details?.channelName;
  const artworkPath = details?.thumbnailPath;
  const folderPath = details?.folderPath;

  useEffect(() => {
    if (!player || !title || !('mediaSession' in navigator)) {
      return;
    }
    const session = navigator.mediaSession;
    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ['play', () => playQuietly(player)],
      ['pause', () => player.pause()],
      ['seekbackward', (actionDetails) => seekBy(player, -(actionDetails.seekOffset ?? SEEK_STEP_SECONDS))],
      ['seekforward', (actionDetails) => seekBy(player, actionDetails.seekOffset ?? SEEK_STEP_SECONDS)],
      [
        'seekto',
        (actionDetails) => {
          if (typeof actionDetails.seekTime === 'number') {
            player.currentTime = actionDetails.seekTime;
          }
        },
      ],
    ];

    guardMediaSession(() => {
      session.metadata = new MediaMetadata({
        title,
        artist: artist ?? '',
        artwork: artworkPath ? [{ src: assetUrl(artworkPath, folderPath) }] : [],
      });
    });
    for (const [action, handler] of handlers) {
      guardMediaSession(() => session.setActionHandler(action, handler));
    }

    return () => {
      guardMediaSession(() => {
        session.metadata = null;
      });
      for (const [action] of handlers) {
        guardMediaSession(() => session.setActionHandler(action, null));
      }
    };
  }, [artist, artworkPath, folderPath, player, title]);
}

export default function VideoDetailPage(): JSX.Element {
  const { videoId } = useParams<{ videoId: string }>();
  const { state, reload } = useVideoDetail(videoId);
  const { t, i18n } = useTranslation();
  // One landmark for every state of the page: the loading and error screens
  // used to render outside any landmark, and nothing moved focus, so a failed
  // route left the user at the top of an unchanged-looking document.
  const mainRef = usePageFocus<HTMLElement>();
  // The player is state, not a ref: the hooks below attach their listeners when
  // the element appears (the details are in) and save when it goes away, and a
  // ref would not tell them either moment.
  const [player, setPlayer] = useState<HTMLVideoElement | null>(null);
  const { position: resumePosition, clear: forgetPosition } = usePlaybackPosition(videoId, player);
  // An answered offer stays answered for as long as this video is on screen:
  // clicking either button, or starting playback by hand, means the viewer is
  // driving. The stored value is the video it was answered for, so the next one
  // gets its own offer.
  const [answeredFor, setAnsweredFor] = useState<string | undefined>(undefined);
  useMediaSession(player, state.details);

  const resumeFrom = (position: number): void => {
    setAnsweredFor(videoId);
    if (player) {
      seekAndPlay(player, position);
    }
  };

  const startFromBeginning = (): void => {
    setAnsweredFor(videoId);
    forgetPosition();
    if (player) {
      seekAndPlay(player, 0);
    }
  };

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

  const videoUrl = assetUrl(state.details.videoPath, state.details.folderPath);
  const posterUrl = assetUrl(state.details.thumbnailPath, state.details.folderPath);
  const subtitleUrl = (subtitlePath: string) => assetUrl(subtitlePath, state.details?.folderPath);

  return (
    <main id={MAIN_CONTENT_ID} className="video-detail-page" ref={mainRef} tabIndex={-1}>
      <title>{t('pageTitle.video', { title: state.details.title })}</title>
      <div className="video-detail-container">
        <div className="video-detail-main">
          <div className="video-player-section">
            {resumePosition !== null && answeredFor !== videoId && (
              <div className="player-resume">
                <Button size="small" variant="primary" onClick={() => resumeFrom(resumePosition)}>
                  {t('video.resumeFrom', { time: formatPlaybackTime(resumePosition) })}
                </Button>
                <Button size="small" onClick={startFromBeginning}>
                  {t('video.startFromBeginning')}
                </Button>
              </div>
            )}
            {/* Native HTML5 video: the files are plain mp4s and the server
                supports Range requests — no react-player dependency needed.
                The poster is the downloaded thumbnail, served by the same
                endpoint as the video file. `playsInline` is what stops iOS from
                taking the video full screen on its own, and preloading only the
                header keeps the self-hosted server from streaming a video the
                viewer may never start. */}
            {/* biome-ignore lint/a11y/useMediaCaption: subtitle tracks are injected dynamically from the API */}
            <video
              ref={setPlayer}
              src={videoUrl}
              poster={posterUrl}
              controls
              playsInline
              preload="metadata"
              className="video-player-full"
              data-testid="video-player"
              onPlay={() => setAnsweredFor(videoId)}
            >
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
