import type { JSX } from 'react';
import { useQueueControls } from '../hooks/useQueueControls';
import { Button } from './ui/Button';

/**
 * Global queue bar on the status page: pause/resume the server-side queue
 * and drop the finished jobs it keeps in memory.
 */
export function QueueControls(): JSX.Element {
  const { loading, paused, finishedCount, setPaused, clearFinished } = useQueueControls();

  return (
    <div className="queue-controls">
      <span className="queue-controls-label">Kolejka pobierania:</span>
      <Button
        disabled={loading}
        onClick={() => void setPaused(!paused)}
        title={
          paused
            ? 'Wznów przetwarzanie kolejki'
            : 'Wstrzymaj przetwarzanie kolejki (bieżące zadania dokończą się)'
        }
      >
        {paused ? 'Wznów kolejkę' : 'Pauza kolejki'}
      </Button>
      <Button
        disabled={loading || finishedCount === 0}
        onClick={() => void clearFinished()}
        title="Usuń zakończone, błędne i anulowane zadania z listy"
      >
        Wyczyść zakończone{finishedCount > 0 ? ` (${finishedCount})` : ''}
      </Button>
    </div>
  );
}
