import type { DownloadState } from '@videodeck/shared/api';
import type { JSX, ReactNode } from 'react';
import { useCallback, useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { useVideoState } from '../hooks/useVideoState';
import { repairVideos, toastRepairResult } from '../utils/libraryActions';
import { formatBytes, missingLabel, needsCompletion } from '../utils/videoState';
import { Button } from './ui/Button';
import { ErrorMessage } from './ui/ErrorMessage';
import { Loading } from './ui/Loading';

interface VideoStatePanelProps {
  folderPath: string;
  video: { id: string; title: string };
  /** A repair was queued: the section re-reads the folder state and the queue */
  onQueueChanged?: () => void;
}

interface PanelRowProps {
  label: string;
  children: ReactNode;
}

/** One line of the panel: what was looked for, and what the disk says */
function PanelRow({ label, children }: PanelRowProps): JSX.Element {
  return (
    <div className="video-state-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** A file the folder does not have: a dash in words, never an empty cell */
function AbsentValue(): JSX.Element {
  const { t } = useTranslation();
  return <span className="video-state-absent">{t('videoState.details.none')}</span>;
}

/** The archive's opinion of one video: on disk, in the file, or disagreeing */
function ArchiveValue({ archive }: { archive: DownloadState['archive'] }): JSX.Element {
  const { t } = useTranslation();
  return (
    <>
      {archive.onDisk && (
        <span className="video-state-badge video-state-badge--info">{t('videoState.details.archiveOnDisk')}</span>
      )}
      {archive.inArchive && (
        <span className="video-state-badge video-state-badge--info">{t('videoState.details.archiveInArchive')}</span>
      )}
      {archive.drift ? (
        <span className="video-state-badge video-state-badge--warn">{t('videoState.details.archiveDrift')}</span>
      ) : (
        <span className="video-state-badge">{t('videoState.details.archiveAgree')}</span>
      )}
    </>
  );
}

/** The files of one video, one row each: size, languages, flags, what is missing */
function FileStateRows({ state }: { state: DownloadState }): JSX.Element {
  const { t, i18n } = useTranslation();
  const { files } = state;
  return (
    <dl className="video-state-list">
      <PanelRow label={t('videoState.details.video')}>
        {files === null ? <AbsentValue /> : <span className="video-state-badge">{t('videoState.badge.video')}</span>}
      </PanelRow>
      {/* The two sizes are separate files: the media on disk, and the
          `.info.json` that holds the description and the comments */}
      <PanelRow label={t('videoState.details.videoSize')}>
        {files === null ? <AbsentValue /> : formatBytes(files.videoBytes, i18n.language)}
      </PanelRow>
      <PanelRow label={t('videoState.details.infoSize')}>
        {files === null ? <AbsentValue /> : formatBytes(files.infoBytes, i18n.language)}
      </PanelRow>
      <PanelRow label={t('videoState.details.thumbnail')}>
        {files?.thumbnail ? (
          <span className="video-state-badge">{t('videoState.badge.thumbnail')}</span>
        ) : (
          <AbsentValue />
        )}
      </PanelRow>
      <PanelRow label={t('videoState.details.description')}>
        {files?.description ? (
          <span className="video-state-badge">{t('videoState.badge.description')}</span>
        ) : (
          <AbsentValue />
        )}
      </PanelRow>
      <PanelRow label={t('videoState.details.subtitles')}>
        {files !== null && files.subLangs.length > 0 ? files.subLangs.join(', ') : <AbsentValue />}
      </PanelRow>
      <PanelRow label={t('videoState.details.comments')}>
        {files?.comments ? (
          <span className="video-state-badge">{t('videoState.badge.comments')}</span>
        ) : (
          <AbsentValue />
        )}
      </PanelRow>
      <PanelRow label={t('videoState.details.archive')}>
        <ArchiveValue archive={state.archive} />
      </PanelRow>
      <PanelRow label={t('videoState.details.missing')}>
        {state.missing.length > 0 ? (
          state.missing.map((entry) => (
            <span key={entry} className="video-state-badge video-state-badge--warn">
              {missingLabel(entry, t)}
            </span>
          ))
        ) : (
          <span className="video-state-absent">{t('videoState.details.nothingMissing')}</span>
        )}
      </PanelRow>
    </dl>
  );
}

/**
 * What one video has on disk, opened from its row: the sizes, the subtitle
 * languages, the archive's opinion and everything that is missing, with the
 * repair for this one video. `GET /api/folder/video-state` answers it, a read
 * of its own because the list endpoint reports one flag per video and no
 * sizes at all.
 */
export function VideoStatePanel({ folderPath, video, onQueueChanged }: VideoStatePanelProps): JSX.Element {
  const { t } = useTranslation();
  const { state, known, loading, error } = useVideoState(folderPath, video.id);
  const [repairing, setRepairing] = useState(false);

  const handleRepair = useCallback((): void => {
    setRepairing(true);
    repairVideos(folderPath, [video.id], 'sidecars')
      .then((result) => {
        toastRepairResult(result, 'sidecars');
        onQueueChanged?.();
      })
      .catch((err: unknown) => {
        toast.error(err instanceof Error ? err.message : t('toast.enqueueFailed'));
      })
      .finally(() => {
        setRepairing(false);
      });
  }, [folderPath, video.id, onQueueChanged, t]);

  return (
    <section className="video-state-panel" aria-label={t('videoState.details.regionLabel', { title: video.title })}>
      {loading && <Loading message={t('videoState.details.loading')} />}
      {error !== null && <ErrorMessage compact>{t('app.error', { message: error })}</ErrorMessage>}
      {!loading && state !== null && !known && <p className="video-state-absent">{t('videoState.details.unknown')}</p>}
      {state !== null && known && (
        <>
          <FileStateRows state={state} />
          {needsCompletion(state) && (
            <Button size="small" variant="primary" onClick={handleRepair} disabled={repairing}>
              {repairing ? t('videoState.details.repairing') : t('videoState.details.repair')}
            </Button>
          )}
        </>
      )}
    </section>
  );
}
