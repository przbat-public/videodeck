import type { JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueueControls } from '../hooks/useQueueControls';
import { Button } from './ui/Button';

/**
 * Global queue bar on the status page: pause/resume the server-side queue
 * and drop the finished jobs it keeps in memory.
 */
export function QueueControls(): JSX.Element {
  const { loading, paused, finishedCount, setPaused, clearFinished } = useQueueControls();
  const { t } = useTranslation();

  return (
    <div className="queue-controls">
      <span className="queue-controls-label">{t('queue.title')}</span>
      <Button
        disabled={loading}
        onClick={() => void setPaused(!paused)}
        title={paused ? t('queue.resumeTitle') : t('queue.pauseTitle')}
      >
        {paused ? t('queue.resume') : t('queue.pause')}
      </Button>
      <Button
        disabled={loading || finishedCount === 0}
        onClick={() => void clearFinished()}
        title={t('queue.clearTitle')}
      >
        {finishedCount > 0
          ? t('queue.clearFinishedWithCount', { count: finishedCount })
          : t('queue.clearFinished')}
      </Button>
    </div>
  );
}
