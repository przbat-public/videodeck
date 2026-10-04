import type { DownloadState } from '@videodeck/shared/api';
import type { JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { missingSummary } from '../utils/videoState';

interface VideoStateBadgesProps {
  /** What the folder state says about this video; absent while it is unknown */
  state: DownloadState | undefined;
}

/**
 * What one video has on disk, as a row of pills: one per artifact that is
 * there, one warning pill naming everything that is not. A video that is not
 * downloaded says so once instead of listing six empty sidecars, because
 * `files: null` is the whole answer for it.
 */
export function VideoStateBadges({ state }: VideoStateBadgesProps): JSX.Element | null {
  const { t } = useTranslation();
  if (state === undefined) {
    return null;
  }

  const { files } = state;
  if (files === null) {
    return (
      <span className="video-state-badges">
        <span className="video-state-badge">{t('videoState.badge.notDownloaded')}</span>
      </span>
    );
  }

  return (
    <span className="video-state-badges">
      <span className="video-state-badge video-state-badge--info">{t('videoState.badge.video')}</span>
      {files.thumbnail && <span className="video-state-badge">{t('videoState.badge.thumbnail')}</span>}
      {files.description && <span className="video-state-badge">{t('videoState.badge.description')}</span>}
      {files.subLangs.length > 0 && (
        <span className="video-state-badge">{t('videoState.badge.subs', { langs: files.subLangs.join(', ') })}</span>
      )}
      {files.comments && <span className="video-state-badge">{t('videoState.badge.comments')}</span>}
      {state.missing.length > 0 && (
        <span className="video-state-badge video-state-badge--warn">{missingSummary(state.missing, t)}</span>
      )}
    </span>
  );
}
