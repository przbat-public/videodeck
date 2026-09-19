import type { JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueueControls } from '../hooks/useQueueControls';
import { Button } from './ui/Button';
import { ErrorMessage } from './ui/ErrorMessage';
import { Tooltip } from './ui/Tooltip';

/**
 * Global queue bar on the status page: pause/resume the server-side queue
 * and drop the finished jobs it keeps in memory.
 */
export function QueueControls(): JSX.Element {
  const { loading, paused, finishedCount, error, setPaused, clearFinished } = useQueueControls();
  const { t } = useTranslation();

  return (
    <>
      <div className="queue-controls">
        <span className="queue-controls-label">{t('queue.title')}</span>
        <Tooltip label={paused ? t('queue.resumeTitle') : t('queue.pauseTitle')}>
          <Button disabled={loading} onClick={() => void setPaused(!paused)}>
            {paused ? t('queue.resume') : t('queue.pause')}
          </Button>
        </Tooltip>
        <Tooltip label={t('queue.clearTitle')}>
          <Button disabled={loading || finishedCount === 0} onClick={() => void clearFinished()}>
            {finishedCount > 0 ? t('queue.clearFinishedWithCount', { count: finishedCount }) : t('queue.clearFinished')}
          </Button>
        </Tooltip>
      </div>
      {error && <ErrorMessage compact>{t('queue.queueError', { message: error })}</ErrorMessage>}
    </>
  );
}
