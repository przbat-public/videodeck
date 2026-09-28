import type { QueueCounts, QueueFolderCounts } from '@videodeck/shared/api';
import { useCallback, useEffect, useRef } from 'react';
import { refreshQueueSummary, useQueueSummary } from '../utils/queueSummaryStore';
import { useLibraryReadKey } from './useLibrary';

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
  const readKey = useLibraryReadKey();
  const baselineRef = useRef<number | null>(null);

  // The counters are per folder, and the folder set is what the library
  // revision moves. The store behind `useQueueSummary` reads once when its
  // first subscriber arrives, which is the mount, so the first key this hook
  // sees must not start a second read for the same thing: it only records the
  // baseline the later moves are compared against.
  useEffect(() => {
    if (!enabled || readKey === null) {
      return;
    }
    if (baselineRef.current === null) {
      baselineRef.current = readKey;
      return;
    }
    void refresh();
  }, [enabled, refresh, readKey]);

  return {
    counts: summary?.counts ?? NO_COUNTS,
    queueByFolder: summary?.folders ?? NO_JOBS_BY_FOLDER,
    error,
    refresh,
  };
}
