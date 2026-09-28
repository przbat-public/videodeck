import type { ReindexStatus } from '@videodeck/shared/api';
import { ReindexStatusSchema } from '@videodeck/shared/schemas';
import toast from 'react-hot-toast';
import i18n from '../i18n';
import { ApiRequestError, apiGet, apiSend } from './apiClient';
import { sleep } from './sleep';

/**
 * The reindex run as one piece of app state instead of one per hook instance.
 *
 * Two surfaces can start and watch a run: the arrival notice in the shell and
 * the results page's menu. With the run in hook-local state each of them had
 * its own `loading`, its own poller and its own toast for the same server job,
 * so the notice's disabled reason described nothing and a second click started
 * a request the server had to refuse with a 409. The run lives here now: one
 * poller, one toast per run, and every surface reads the same state.
 */

/** How often the poller asks the server whether the run is over */
export const DEFAULT_POLL_INTERVAL_MS = 2000;

export interface ReindexState {
  /** True from the click until the server reports the run finished */
  loading: boolean;
  /** Last status the server reported; null before the first run */
  status: ReindexStatus | null;
}

export interface ReindexRunOptions {
  /** Skip the folders whose index already exists (a drive that came back) */
  onlyMissing?: boolean;
  /** Test seam: how often the run's progress is polled */
  pollIntervalMs?: number;
}

const IDLE_STATE: ReindexState = { loading: false, status: null };

let state: ReindexState = IDLE_STATE;
let inFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();
const finishedListeners = new Set<(status: ReindexStatus) => void>();

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

function setState(next: ReindexState): void {
  state = next;
  emit();
}

export function getReindexState(): ReindexState {
  return state;
}

export function subscribeReindexState(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Every finished run, whoever started it. This is the one place that knows a
 * run is over, so the rule "re-read what the run changed" has one home instead
 * of living in whichever caller happened to click.
 */
export function subscribeReindexFinished(listener: (status: ReindexStatus) => void): () => void {
  finishedListeners.add(listener);
  return () => {
    finishedListeners.delete(listener);
  };
}

function folderName(folderPath?: string): string {
  if (!folderPath) return '';
  const parts = folderPath.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? folderPath;
}

/** One-line progress text for the loading toast */
export function formatReindexProgress(status: ReindexStatus): string {
  const folderPart =
    status.foldersTotal > 0
      ? i18n.t('reindex.progressFolder', {
          folder: status.foldersDone + 1,
          total: status.foldersTotal,
        })
      : '';
  const filesPart =
    status.filesTotal > 0
      ? i18n.t('reindex.progressFiles', {
          filesDone: status.filesDone,
          filesTotal: status.filesTotal,
        })
      : '';
  const parts = [
    i18n.t('reindex.progressLabel'),
    folderPart,
    folderName(status.currentFolder),
    filesPart,
    i18n.t('reindex.progressIndexed', { count: status.indexed }),
  ].filter(Boolean);
  return parts.join(' · ');
}

/** Final message once the run is over */
export function formatReindexResult(status: ReindexStatus): string {
  // A skipped run (onlyMissing with every folder cached) scans nothing
  if (status.foldersTotal === 0 && status.indexed === 0) {
    return i18n.t('reindex.nothingToDo');
  }
  const base = i18n.t(status.skipped > 0 ? 'reindex.finishedWithSkipped' : 'reindex.finished', {
    indexed: status.indexed,
    skipped: status.skipped,
  });
  const errors = status.errors.length > 0 ? `, ${i18n.t('reindex.folderError', { count: status.errors.length })}` : '';
  return `${base}${errors}`;
}

async function fetchStatus(signal: AbortSignal): Promise<ReindexStatus> {
  return apiGet('/api/videos/refreshCache/status', ReindexStatusSchema, {
    signal,
    failureMessage: (_failure, status) => i18n.t('reindex.statusFailed', { status }),
  });
}

/** Kicks the server-side run off; a 409 means one is already running */
async function startReindex(url: string, signal: AbortSignal, loadingToastId: string): Promise<void> {
  try {
    await apiSend('POST', url, null, undefined, {
      signal,
      failureMessage: (failure, status) => failure.message ?? `HTTP error! status: ${status}`,
    });
  } catch (err) {
    if (!(err instanceof ApiRequestError) || err.status !== 409) {
      throw err;
    }
    // A run is already going; the poll below follows it to the end
    toast.loading(i18n.t('reindex.alreadyRunning'), { id: loadingToastId });
  }
}

/** Follows the background job until the server says it is done */
async function pollReindexUntilFinished(
  signal: AbortSignal,
  pollIntervalMs: number,
  loadingToastId: string,
): Promise<ReindexStatus> {
  let current = await fetchStatus(signal);
  setState({ loading: true, status: current });
  while (current.running) {
    toast.loading(formatReindexProgress(current), { id: loadingToastId });
    await sleep(pollIntervalMs);
    // A hidden tab still owns the run, it just stops asking: the server keeps
    // working and the next visible poll picks the progress up where it is
    if (document.visibilityState === 'hidden') {
      continue;
    }
    current = await fetchStatus(signal);
    setState({ loading: true, status: current });
  }
  return current;
}

/** Report one finished run: its toast, then everyone waiting on the outcome */
function reportReindexResult(finished: ReindexStatus, loadingToastId: string): void {
  const summary = formatReindexResult(finished);
  if (finished.errors.length > 0) {
    toast.error(`${summary}. ${finished.lastError ?? ''}`.trim(), { id: loadingToastId });
  } else {
    toast.success(summary, { id: loadingToastId });
  }
  for (const listener of [...finishedListeners]) {
    listener(finished);
  }
}

/** One run: start it, follow it, report it. Never rejects; the toast carries it */
async function runReindex(
  current: AbortController,
  pollIntervalMs: number,
  loadingToastId: string,
  onlyMissing: boolean,
): Promise<void> {
  try {
    const url = onlyMissing ? '/api/videos/refreshCache?onlyMissing=1' : '/api/videos/refreshCache';
    await startReindex(url, current.signal, loadingToastId);
    const finished = await pollReindexUntilFinished(current.signal, pollIntervalMs, loadingToastId);
    reportReindexResult(finished, loadingToastId);
  } catch (err) {
    toast.error(err instanceof Error ? err.message : i18n.t('reindex.startFailed'), { id: loadingToastId });
  }
}

/**
 * Start a reindex, or join the one already running. The promise resolves when
 * the run is over, so a caller that wants to act on the outcome can await it,
 * and a second caller gets the same run instead of a second job.
 *
 * No surface stops a run, so the controller here only carries the signal the
 * requests take; the run is followed to the end whoever started it.
 */
export function refreshCache(options: ReindexRunOptions = {}): Promise<void> {
  if (inFlight !== null) {
    return inFlight;
  }
  const current = new AbortController();
  setState({ loading: true, status: state.status });
  const loadingToastId = toast.loading(i18n.t('reindex.starting'));

  inFlight = runReindex(
    current,
    options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    loadingToastId,
    options.onlyMissing === true,
  ).finally(() => {
    inFlight = null;
    setState({ loading: false, status: state.status });
  });

  return inFlight;
}

/** Tests: forget the run state (the poller of a live run is not touched) */
export function resetReindexState(): void {
  inFlight = null;
  state = IDLE_STATE;
  emit();
}
