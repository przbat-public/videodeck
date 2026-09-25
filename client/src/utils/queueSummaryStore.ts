import type { QueueSummaryResponse } from '@videodeck/shared/api';
import { QueueSummaryResponseSchema } from '@videodeck/shared/schemas';
import { useCallback, useSyncExternalStore } from 'react';
import i18n from '../i18n';

/**
 * The queue's counters, as one small store instead of a context.
 *
 * The status page used to run two pollers over the whole queue (the channel
 * console every 1.5 s and the queue bar every 4 s), and on a real instance the
 * answer was megabytes of job logs nobody rendered. Both now read this store,
 * which polls GET /api/folder/queue/summaries once while something is queued
 * or running.
 */

/** How often the shared poller re-reads the counters while work is pending */
export const QUEUE_SUMMARY_POLL_MS = 1500;

export interface QueueSummaryState {
  /** Last answer; null until the first one lands */
  summary: QueueSummaryResponse | null;
  /** Last failed read; cleared by the next successful one */
  error: string | null;
}

let state: QueueSummaryState = { summary: null, error: null };
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let controller: AbortController | null = null;

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

function setState(next: QueueSummaryState): void {
  state = next;
  emit();
}

/** Whether the answer says the queue still has work, which keeps the poll alive */
function hasActiveWork(summary: QueueSummaryResponse | null): boolean {
  return summary !== null && summary.counts.queued + summary.counts.running > 0;
}

function stopPolling(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

/**
 * Poll only while something is queued or running (the console asks once when it
 * mounts, and again after every action it takes), and not while the tab is
 * hidden: the browser throttles timers anyway, so skip the request early.
 */
function ensurePolling(): void {
  if (timer !== null || listeners.size === 0 || !hasActiveWork(state.summary)) {
    return;
  }
  timer = setInterval(() => {
    if (document.visibilityState !== 'hidden') {
      void refreshQueueSummary();
    }
  }, QUEUE_SUMMARY_POLL_MS);
}

/**
 * Read the counters once. A refresh supersedes the one in flight, so a slow
 * answer cannot land after a fresher one (the pause click does exactly that).
 */
export async function refreshQueueSummary(): Promise<void> {
  controller?.abort();
  const current = new AbortController();
  controller = current;
  try {
    const response = await fetch('/api/folder/queue/summaries', { cache: 'no-store', signal: current.signal });
    if (!response.ok) {
      throw new Error(i18n.t('errors.loadQueue'));
    }
    const summary = QueueSummaryResponseSchema.parse(await response.json());
    if (current.signal.aborted) {
      return; // a newer read (or unmount) took over while the body was parsed
    }
    setState({ summary, error: null });
    if (hasActiveWork(summary)) {
      ensurePolling();
    } else {
      stopPolling();
    }
  } catch (error) {
    if (current.signal.aborted) {
      return; // superseded by a newer refresh or unmounted: nothing to report
    }
    setState({ summary: state.summary, error: error instanceof Error ? error.message : i18n.t('errors.loadQueue') });
  }
}

/** The tab came back to the foreground: re-read at once instead of waiting */
function onWindowFocus(): void {
  void refreshQueueSummary();
}

export function subscribeQueueSummary(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    void refreshQueueSummary();
    window.addEventListener('focus', onWindowFocus);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      stopPolling();
      controller?.abort();
      controller = null;
      window.removeEventListener('focus', onWindowFocus);
    }
  };
}

export function getQueueSummaryState(): QueueSummaryState {
  return state;
}

/** Reactive read of the counters; `enabled: false` subscribes to nothing */
export function useQueueSummary(enabled = true): QueueSummaryState {
  // Stable identity per `enabled`: a fresh subscribe function would make React
  // unsubscribe and resubscribe on every render, and the first subscriber
  // starts a read — that loop never settles.
  const subscribe = useCallback(
    (listener: () => void) => (enabled ? subscribeQueueSummary(listener) : () => undefined),
    [enabled],
  );
  return useSyncExternalStore(subscribe, getQueueSummaryState, getQueueSummaryState);
}

/** Tests: forget the last answer and stop the poller */
export function resetQueueSummaryStore(): void {
  stopPolling();
  controller?.abort();
  controller = null;
  state = { summary: null, error: null };
  emit();
}
