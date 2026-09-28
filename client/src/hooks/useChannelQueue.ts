import type { QueueCounts, QueueFolderCounts } from '@videodeck/shared/api';
import { useCallback, useEffect } from 'react';
import { refreshQueueSummary, useQueueSummary } from '../utils/queueSummaryStore';
import { useLibraryRevision } from './useLibrary';

/** The empty answers, so a consumer without a summary yet reads zeroes */
const NO_JOBS_BY_FOLDER: Record<string, QueueFolderCounts> = {};
const NO_COUNTS: QueueCounts = { queued: 0, running: 0, done: 0, error: 0, cancelled: 0 };

interface UseChannelQueueResult {
  /** Counters per status, for the whole queue */
  counts: QueueCounts;
  /** Counters per folder path, ready for the console's rows */
  queueByFolder: Record<string, QueueFolderCounts>;
  error: string | null;
  refresh: () => Promise<void>;
}

/**
 * The queue's counters for the channel console's one row per channel. One
 * shared poller covers every channel and both consumers (this hook and the
 * queue bar), and it keeps asking only while something is queued or running.
 * The job list itself is never pulled here: a folder's own jobs are read by
 * the folder section that renders them.
 */
export function useChannelQueue(enabled = true): UseChannelQueueResult {
  const { summary, error } = useQueueSummary(enabled);
  const refresh = useCallback(() => refreshQueueSummary(), []);
  const revision = useLibraryRevision();

  // The counters are per folder, and the folder set is what the library
  // revision moves. Revision 0 is the state before anything is known: the
  // store's own first read already covers the mount, so this skips it rather
  // than asking twice for the same thing.
  useEffect(() => {
    if (!enabled || revision === 0) {
      return;
    }
    void refresh();
  }, [enabled, refresh, revision]);

  return {
    counts: summary?.counts ?? NO_COUNTS,
    queueByFolder: summary?.folders ?? NO_JOBS_BY_FOLDER,
    error,
    refresh,
  };
}
