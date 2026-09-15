import { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import type { DownloadOptions, JobStatus, JobType, QueueJob } from '@videodeck/shared/api';
import { extractYtDlpProgress } from '@videodeck/shared/progress';
import { removePartialDownloads, writeTextAtomic } from '../utils/fsUtils';
import { logger } from '../utils/logger';
import { stripUndefined } from '../utils/objectUtils';
import { refreshIndex } from './folderIndex';
import { indexVideosFromDisk } from './videoScanner';
import { buildYtDlpArgs } from './ytdlp';
import { detectPermanentFailure } from './ytdlpFailures';

/**
 * Server-side yt-dlp job queue.
 *
 * Jobs live and run independently of HTTP requests: closing a browser tab no
 * longer kills a half-finished download.
 *
 * Two job types, each with its own concurrency limit:
 *  - `download`: full download with `--download-archive archive.txt`, so a
 *    video whose title changed on YouTube is never downloaded twice. At most
 *    `maxConcurrent` at a time and only one per folder, because every
 *    download appends to that folder's archive.txt.
 *  - `update`: metadata-only refresh (`--skip-download`) written under the
 *    *existing* file stem, so info.json / subtitles / thumbnail are overwritten
 *    in place instead of creating a second set of files under a new title.
 *    At most `maxConcurrentUpdates` at a time, any number per folder: each
 *    one touches only its own files.
 *
 * The hook that runs after a job rewrites the folder index, so hooks run one
 * at a time per folder whatever the number of yt-dlp processes.
 *
 * `QueueJob` (the snapshot sent to clients) is defined in shared/api.ts.
 */

export interface EnqueueRequest {
  folderPath: string;
  videoId: string;
  videoUrl: string;
  title?: string;
  type: JobType;
  baseName?: string;
  options?: DownloadOptions;
}

/** The part of `ChildProcess` the queue relies on (tests pass fakes) */
export interface SpawnedProcess {
  stdout: Pick<EventEmitter, 'on'> | null;
  stderr: Pick<EventEmitter, 'on'> | null;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'close', listener: (code: number | null) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
  pid?: number;
}

export type SpawnFn = (command: string, args: string[], options: { cwd: string; detached?: boolean }) => SpawnedProcess;

/**
 * Signal the child and its whole process group (yt-dlp spawns ffmpeg as a
 * group member; killing only the parent would orphan the merge process).
 * Group kills need the child spawned with `detached: true`.
 */
export function killProcessGroup(child: SpawnedProcess | undefined, signal: NodeJS.Signals): void {
  if (!child) {
    return;
  }
  child.kill(signal);
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
    } catch {
      // Group already gone — nothing left to signal
    }
  }
}

export interface DownloadQueueOptions {
  /** Running `download` jobs at once (default 2) */
  maxConcurrent?: number;
  /** Running `update` jobs at once (default 2) */
  maxConcurrentUpdates?: number;
  logTail?: number;
  /** Keep finished jobs for this long before pruning (ms) */
  retainFinishedMs?: number;
  /** How many times a failed yt-dlp run is retried (default 3) */
  maxAttempts?: number;
  /** Base of the retry backoff (ms, default 30 s; grows exponentially with jitter) */
  retryDelayMs?: number;
  /** Kill a job that produced no output for this long (ms, default 10 min) */
  idleTimeoutMs?: number;
  /** Kill a job that outlived this wall-clock limit (ms, default 8 h) */
  maxJobDurationMs?: number;
  spawnFn?: SpawnFn;
  /** Called after a job finishes successfully (default: refresh folder index) */
  afterJob?: (job: QueueJob) => Promise<void>;
  ytDlpPath?: string;
  /** Persist the active jobs (and the paused flag) to this file for restarts */
  stateFile?: string;
}

function isActive(job: QueueJob): boolean {
  return job.status === 'queued' || job.status === 'running';
}

/**
 * Default post-job hook: refresh the folder's `.videos-index.json` and push
 * the videos whose files changed during the job into Elasticsearch, so a
 * download or metadata update is searchable without a full reindex.
 *
 * When Elasticsearch is down the failure is NOT swallowed: the index mtimes
 * are already updated by refreshIndex, so the change would never be
 * re-detected — the batch is retried in the background with backoff instead
 * of losing the video from search until the next full reindex.
 */
export async function indexChangedVideos(job: QueueJob): Promise<void> {
  const since = new Date(job.startedAt ?? job.createdAt).getTime();
  const { index, changed } = await refreshIndex(job.folderPath, since);
  const baseNames = changed
    .map((videoId) => index.entries[videoId]?.baseName)
    .filter((baseName): baseName is string => typeof baseName === 'string');
  if (baseNames.length === 0) {
    return;
  }
  try {
    const indexed = await indexVideosFromDisk(job.folderPath, baseNames);
    logger.info(`Job ${job.id}: indexed ${indexed}/${baseNames.length} changed videos in Elasticsearch`);
  } catch (error) {
    logger.error(`Job ${job.id}: cannot index changed videos, will retry:`, error);
    scheduleIndexRetry(job.folderPath, baseNames);
  }
}

/** Folders whose incremental indexing failed and is waiting for a retry */
const indexRetryTimers = new Map<string, NodeJS.Timeout>();
/** Backoff per folder: 30 s, 2 min, 8 min, then give up */
const INDEX_RETRY_DELAYS_MS = [30_000, 120_000, 480_000];

/** Tests: drop pending index retries */
export function clearIndexRetries(): void {
  for (const timer of indexRetryTimers.values()) {
    clearTimeout(timer);
  }
  indexRetryTimers.clear();
}

function scheduleIndexRetry(folderPath: string, baseNames: string[], attempt = 0): void {
  const existing = indexRetryTimers.get(folderPath);
  if (existing) {
    clearTimeout(existing); // a newer failure supersedes the pending retry
  }
  if (attempt >= INDEX_RETRY_DELAYS_MS.length) {
    logger.error(`Giving up indexing ${baseNames.length} videos in ${folderPath} after ${attempt} retries`);
    return;
  }
  const delay = INDEX_RETRY_DELAYS_MS[attempt] ?? 480_000;
  const timer = setTimeout(() => {
    indexRetryTimers.delete(folderPath);
    indexVideosFromDisk(folderPath, baseNames)
      .then((indexed) => logger.info(`Retry indexed ${indexed}/${baseNames.length} videos in ${folderPath}`))
      .catch((error: unknown) => {
        logger.error(`Index retry failed for ${folderPath}:`, error);
        scheduleIndexRetry(folderPath, baseNames, attempt + 1);
      });
  }, delay);
  timer.unref();
  indexRetryTimers.set(folderPath, timer);
}

export class DownloadQueue extends EventEmitter {
  private readonly jobs = new Map<string, QueueJob>();
  private readonly processes = new Map<string, SpawnedProcess>();
  /** Tail of the afterJob chain per folder; absent when no hook is pending */
  private readonly folderHooks = new Map<string, Promise<void>>();
  private readonly maxConcurrent: number;
  private readonly maxConcurrentUpdates: number;
  private readonly logTail: number;
  private readonly retainFinishedMs: number;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly idleTimeoutMs: number;
  private readonly maxJobDurationMs: number;
  private readonly spawnFn: SpawnFn;
  private readonly afterJob: (job: QueueJob) => Promise<void>;
  private readonly ytDlpPath: string;
  private readonly stateFile: string | undefined;
  /** Spawns already used by a job (cleared when it finishes) */
  private readonly attempts = new Map<string, number>();
  /** Pending retry timers, keyed by job id (cleared on cancel) */
  private readonly retryTimers = new Map<string, NodeJS.Timeout>();
  /** Watchdog timers per running job (idle + wall-clock checks) */
  private readonly watchdogs = new Map<string, { interval: NodeJS.Timeout; maxTimer: NodeJS.Timeout }>();
  /** Last time a running job produced output (watchdog input) */
  private readonly lastOutputAt = new Map<string, number>();
  /** Jobs killed by the watchdog (retried as transient failures) */
  private readonly hungJobs = new Map<string, true>();
  /** While paused, queued jobs wait; running ones finish (cancel still works) */
  private paused = false;

  constructor(options: DownloadQueueOptions = {}) {
    super();
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? 2);
    this.maxConcurrentUpdates = Math.max(1, options.maxConcurrentUpdates ?? 2);
    this.logTail = options.logTail ?? 40;
    this.retainFinishedMs = options.retainFinishedMs ?? 60 * 60 * 1000;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    this.retryDelayMs = options.retryDelayMs ?? 30_000;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 10 * 60 * 1000;
    this.maxJobDurationMs = options.maxJobDurationMs ?? 8 * 60 * 60 * 1000;
    this.spawnFn =
      options.spawnFn ??
      ((command, args, opts) =>
        // The real ChildProcess satisfies SpawnedProcess structurally, but
        // its overloaded EventEmitter typing needs the narrowing cast.
        nodeSpawn(command, args, { cwd: opts.cwd, detached: opts.detached }) as unknown as SpawnedProcess);
    this.afterJob = options.afterJob ?? indexChangedVideos;
    this.ytDlpPath = options.ytDlpPath ?? 'yt-dlp';
    this.stateFile = options.stateFile;
  }

  /**
   * Persist the active jobs and the paused flag, so a reboot can re-enqueue
   * them (archive.txt dedups downloads; updates are idempotent re-scans).
   * Writes are chained: atomic renames race when they run in parallel, and
   * an older snapshot landing last would resurrect stale jobs or a stale
   * paused flag. A failed write must never break the queue or the chain.
   */
  private persistChain: Promise<void> = Promise.resolve();

  private persistState(): void {
    const stateFile = this.stateFile;
    if (!stateFile) {
      return;
    }
    const jobs = Array.from(this.jobs.values())
      .filter(isActive)
      .map((job) => ({ ...job, log: [], logLineCount: 0 }));
    const text = JSON.stringify({ paused: this.paused, jobs });
    this.persistChain = this.persistChain
      .catch(() => undefined)
      .then(() => writeTextAtomic(stateFile, text))
      .catch((error: unknown) => {
        logger.warn(`Cannot persist queue state: ${error instanceof Error ? error.message : String(error)}`);
      });
  }

  /** Resolve once every process is gone (or the timeout passes) */
  async waitForIdle(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.processes.size > 0 && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
  }

  /**
   * Add jobs. A job identical (folder + videoId) to one already queued or
   * running is not duplicated — the existing job is returned instead. The
   * dedup spans job types on purpose: an update racing a download of the
   * same video would overwrite the file the download is writing.
   */
  enqueue(requests: EnqueueRequest[]): QueueJob[] {
    const result: QueueJob[] = [];
    for (const request of requests) {
      const existing = this.findActive(request.folderPath, request.videoId);
      if (existing) {
        result.push(existing);
        continue;
      }
      const job = stripUndefined<QueueJob>({
        id: randomUUID(),
        folderPath: request.folderPath,
        videoId: request.videoId,
        videoUrl: request.videoUrl,
        title: request.title,
        type: request.type,
        baseName: request.baseName,
        options: request.options,
        status: 'queued',
        log: [],
        logLineCount: 0,
        createdAt: new Date().toISOString(),
      });
      this.jobs.set(job.id, job);
      result.push(job);
      this.emitJob(job);
    }
    this.prune();
    this.persistState();
    this.pump();
    return result.map((job) => this.snapshot(job));
  }

  get(id: string): QueueJob | undefined {
    const job = this.jobs.get(id);
    return job ? this.snapshot(job) : undefined;
  }

  list(folderPath?: string): QueueJob[] {
    this.prune();
    const jobs = Array.from(this.jobs.values()).filter((job) => !folderPath || job.folderPath === folderPath);
    return jobs.map((job) => this.snapshot(job));
  }

  /**
   * Cancel a queued job (removed) or a running job (process killed).
   */
  cancel(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job || !isActive(job)) {
      return false;
    }
    if (job.status === 'running') {
      const child = this.processes.get(id);
      job.status = 'cancelled';
      job.finishedAt = new Date().toISOString();
      this.emitJob(job);
      // Stop a pending retry from resurrecting the job
      const timer = this.retryTimers.get(id);
      if (timer) {
        clearTimeout(timer);
        this.retryTimers.delete(id);
      }
      killProcessGroup(child, 'SIGTERM');
      // 'close' handler will clean up the process map and pump the queue
      return true;
    }
    job.status = 'cancelled';
    job.finishedAt = new Date().toISOString();
    this.emitJob(job);
    this.persistState();
    return true;
  }

  cancelAll(folderPath?: string): number {
    let count = 0;
    for (const job of this.jobs.values()) {
      if (isActive(job) && (!folderPath || job.folderPath === folderPath)) {
        if (this.cancel(job.id)) {
          count += 1;
        }
      }
    }
    return count;
  }

  /** Cancel everything and forget all jobs (used by tests). */
  clear(): void {
    this.cancelAll();
    for (const timer of this.retryTimers.values()) {
      clearTimeout(timer);
    }
    this.retryTimers.clear();
    for (const watchdog of this.watchdogs.values()) {
      clearInterval(watchdog.interval);
      clearTimeout(watchdog.maxTimer);
    }
    this.watchdogs.clear();
    this.lastOutputAt.clear();
    this.hungJobs.clear();
    this.attempts.clear();
    this.jobs.clear();
    this.processes.clear();
  }

  /** Remove finished jobs older than the retention window. */
  prune(now: number = Date.now()): void {
    for (const [id, job] of this.jobs) {
      if (isActive(job) || !job.finishedAt) {
        continue;
      }
      if (now - new Date(job.finishedAt).getTime() > this.retainFinishedMs) {
        this.jobs.delete(id);
      }
    }
  }

  private findActive(folderPath: string, videoId: string): QueueJob | undefined {
    for (const job of this.jobs.values()) {
      if (isActive(job) && job.folderPath === folderPath && job.videoId === videoId) {
        return job;
      }
    }
    return undefined;
  }

  private running(type: JobType): QueueJob[] {
    return Array.from(this.jobs.values()).filter((job) => job.status === 'running' && job.type === type);
  }

  /**
   * Whether a queued job may start now. Downloads and updates are counted
   * against separate limits; only downloads are exclusive within a folder,
   * because only they append to the folder's archive.txt.
   */
  private canStart(job: QueueJob): boolean {
    if (job.type === 'update') {
      return this.running('update').length < this.maxConcurrentUpdates;
    }
    const downloads = this.running('download');
    return downloads.length < this.maxConcurrent && !downloads.some((running) => running.folderPath === job.folderPath);
  }

  /** Start every queued job that may run, oldest first; a blocked job does not hold up the ones behind it */
  private pump(): void {
    if (this.paused) {
      return;
    }
    for (const job of this.jobs.values()) {
      if (job.status === 'queued' && this.canStart(job)) {
        this.start(job);
      }
    }
  }

  /** Pause/resume: running jobs finish, queued ones wait while paused */
  setPaused(paused: boolean): void {
    if (this.paused === paused) {
      return;
    }
    this.paused = paused;
    this.persistState();
    if (!paused) {
      this.pump();
    }
  }

  /** Forget finished (done/error/cancelled) jobs; returns how many were dropped */
  clearFinished(): number {
    let cleared = 0;
    for (const [id, job] of this.jobs) {
      if (!isActive(job)) {
        this.jobs.delete(id);
        cleared += 1;
      }
    }
    return cleared;
  }

  private start(job: QueueJob): void {
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    job.progress = 0;
    this.emitJob(job);

    let child: SpawnedProcess;
    try {
      // detached: the child leads its own process group, so a hang can be
      // killed together with ffmpeg instead of leaving an orphan merge.
      child = this.spawnFn(this.ytDlpPath, buildYtDlpArgs(job), { cwd: job.folderPath, detached: true });
    } catch (error) {
      this.finish(job, 'error', error instanceof Error ? error.message : String(error), null);
      return;
    }
    this.processes.set(job.id, child);
    this.attempts.set(job.id, (this.attempts.get(job.id) ?? 0) + 1);
    this.lastOutputAt.set(job.id, Date.now());
    this.armWatchdog(job);

    const onData = (chunk: Buffer | string) => this.appendLog(job, chunk.toString());
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);

    child.on('error', (error) => {
      this.appendLog(job, `spawn error: ${error.message}`);
      if (job.status === 'running') {
        // A spawn error is permanent (yt-dlp missing, bad args) — no retry
        this.finish(job, 'error', error.message, null);
      }
    });

    child.on('close', (code) => this.onJobClose(job, code));
  }

  /**
   * Watchdog against hung yt-dlp processes: no output for `idleTimeoutMs`
   * (a dead network path, a D-state I/O on an unplugged disk, a stuck ffmpeg
   * merge) or a wall-clock overrun past `maxJobDurationMs` kills the whole
   * process group. Without it a stall holds the folder's download slot and
   * the global slot forever — SIGTERM alone cannot kill D-state processes.
   */
  private armWatchdog(job: QueueJob): void {
    const interval = setInterval(
      () => {
        if (job.status !== 'running') {
          return;
        }
        const lastOutput = this.lastOutputAt.get(job.id) ?? Date.now();
        if (Date.now() - lastOutput > this.idleTimeoutMs) {
          this.killHungJob(
            job,
            `No output for ${Math.round(this.idleTimeoutMs / 1000)}s — killing the hung yt-dlp process`,
          );
        }
      },
      Math.min(Math.floor(this.idleTimeoutMs / 4), 60_000),
    );
    interval.unref();
    const maxTimer = setTimeout(() => {
      if (job.status === 'running') {
        this.killHungJob(
          job,
          `Job exceeded the ${Math.round(this.maxJobDurationMs / 60_000)}min limit — killing yt-dlp`,
        );
      }
    }, this.maxJobDurationMs);
    maxTimer.unref();
    this.watchdogs.set(job.id, { interval, maxTimer });
  }

  /** SIGTERM the process group of a hung job, escalating to SIGKILL */
  private killHungJob(job: QueueJob, reason: string): void {
    this.appendLog(job, reason);
    this.hungJobs.set(job.id, true);
    const child = this.processes.get(job.id);
    killProcessGroup(child, 'SIGTERM');
    setTimeout(() => {
      // Only if the same process is still around (the close handler has not run)
      if (this.processes.get(job.id) === child) {
        killProcessGroup(child, 'SIGKILL');
      }
    }, 5_000).unref();
  }

  private disarmWatchdog(jobId: string): void {
    const watchdog = this.watchdogs.get(jobId);
    if (watchdog) {
      clearInterval(watchdog.interval);
      clearTimeout(watchdog.maxTimer);
      this.watchdogs.delete(jobId);
    }
    this.lastOutputAt.delete(jobId);
  }

  /**
   * Handle the process `close` of a job: success runs the post-job hook,
   * permanent failures fail right away, everything else is retried.
   */
  private onJobClose(job: QueueJob, code: number | null): void {
    this.processes.delete(job.id);
    this.disarmWatchdog(job.id);
    const hung = this.hungJobs.has(job.id);
    this.hungJobs.delete(job.id);
    if (job.status !== 'running') {
      // Already cancelled or failed via 'error'. A cancelled download was
      // killed mid-write: sweep the temporary files yt-dlp left behind.
      if (job.status === 'cancelled' && job.type === 'download') {
        void removePartialDownloads(job.folderPath);
      }
      this.pump();
      return;
    }
    if (hung) {
      // The watchdog killed a stalled process: retry like any transient
      // failure (yt-dlp resumes partial files with -c), bounded by attempts.
      this.appendLog(job, 'yt-dlp process was killed by the watchdog');
      this.retryOrFail(job, code);
      return;
    }
    if (code === 0) {
      // With -i, yt-dlp exits 0 even for extractor errors (members-only,
      // private, removed) — detect them from the log so such videos are
      // never marked as downloaded.
      const permanent = detectPermanentFailure(job.log);
      if (permanent) {
        this.appendLog(job, permanent.description);
        this.finish(job, 'error', permanent.code, code);
        return;
      }
      job.progress = 100;
      void this.runAfterJob(job).then(() => this.finish(job, 'done', undefined, code));
      return;
    }

    // Videos that can never succeed (members-only, private, removed, full
    // disk, geo-block, bot wall, age gate) skip the retry backoff entirely —
    // waiting would only waste time.
    const permanent = detectPermanentFailure(job.log);
    if (permanent) {
      this.appendLog(job, permanent.description);
      this.finish(job, 'error', permanent.code, code);
      return;
    }

    this.retryOrFail(job, code);
  }

  /** Retry a failed yt-dlp run with jittered backoff, or fail when attempts run out */
  private retryOrFail(job: QueueJob, code: number | null): void {
    // YouTube throttles (429) and transient network failures are common:
    // retry a few times with a jittered exponential backoff before declaring
    // the job failed. Full jitter keeps synchronized retry storms from
    // hammering YouTube in lockstep.
    const attempts = this.attempts.get(job.id) ?? 1;
    if (attempts >= this.maxAttempts) {
      this.finish(job, 'error', `yt-dlp exited with code ${code} after ${attempts} attempts`, code);
      return;
    }
    const exponent = Math.min(attempts, 5);
    const cap = this.retryDelayMs * 2 ** exponent;
    const delay = Math.floor(Math.random() * cap);
    job.progress = 0;
    this.appendLog(
      job,
      `yt-dlp exited with code ${code} — retrying in ${Math.round(delay / 1000)}s (attempt ${attempts}/${this.maxAttempts})`,
    );
    const timer = setTimeout(() => {
      this.retryTimers.delete(job.id);
      if (job.status === 'running') {
        this.start(job);
      } else {
        this.pump();
      }
    }, delay);
    this.retryTimers.set(job.id, timer);
    this.pump();
  }

  /**
   * Runs the post-job hook after every hook already pending for the same
   * folder. The hook rewrites the folder's index file, and two rewrites at
   * once would lose each other's changes. Never rejects: a failed hook is
   * logged and does not hold up the hooks queued behind it.
   */
  private runAfterJob(job: QueueJob): Promise<void> {
    const previous = this.folderHooks.get(job.folderPath) ?? Promise.resolve();
    const current = previous
      .then(() => this.afterJob(job))
      .catch((error: unknown) => {
        logger.error(`downloadQueue: afterJob failed for ${job.videoId}:`, error);
      })
      .finally(() => {
        if (this.folderHooks.get(job.folderPath) === current) {
          this.folderHooks.delete(job.folderPath);
        }
      });
    this.folderHooks.set(job.folderPath, current);
    return current;
  }

  private finish(job: QueueJob, status: JobStatus, error: string | undefined, code: number | null) {
    job.status = status;
    if (error === undefined) {
      delete job.error;
    } else {
      job.error = error;
    }
    job.exitCode = code;
    job.finishedAt = new Date().toISOString();
    this.attempts.delete(job.id);
    this.emitJob(job);
    this.persistState();
    this.pump();
  }

  private appendLog(job: QueueJob, text: string): void {
    this.lastOutputAt.set(job.id, Date.now());
    const lines = text.split(/\r\n|\r|\n/).filter((line) => line.trim().length > 0);
    if (lines.length === 0) {
      return;
    }
    for (const line of lines) {
      const progress = extractYtDlpProgress(line);
      if (progress !== undefined) {
        job.progress = progress;
      }
    }
    job.log.push(...lines);
    job.logLineCount += lines.length;
    if (job.log.length > this.logTail) {
      job.log.splice(0, job.log.length - this.logTail);
    }
    this.emitJob(job);
  }

  private emitJob(job: QueueJob): void {
    this.emit('job', this.snapshot(job));
  }

  private snapshot(job: QueueJob): QueueJob {
    return { ...job, log: [...job.log] };
  }
}

/** A positive integer from the environment, or the fallback for anything else */
export function readConcurrency(value: string | undefined, fallback: number): number {
  const parsed = parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Where the singleton persists its active jobs (cwd = server/ by default) */
export const QUEUE_STATE_FILE = process.env.QUEUE_STATE_FILE ?? '.queue-state.json';

/**
 * The yt-dlp binary the queue spawns: overridable per process (deep
 * integration tests point it at the fake binary), defaulting to PATH.
 */
export const YTDLP_PATH = process.env.YTDLP_PATH ?? 'yt-dlp';

/** Application-wide queue instance */
export const downloadQueue = new DownloadQueue({
  maxConcurrent: readConcurrency(process.env.DOWNLOAD_CONCURRENCY, 2),
  maxConcurrentUpdates: readConcurrency(process.env.UPDATE_CONCURRENCY, 2),
  maxAttempts: readConcurrency(process.env.DOWNLOAD_MAX_ATTEMPTS, 3),
  stateFile: QUEUE_STATE_FILE,
  ytDlpPath: YTDLP_PATH,
});

/**
 * Re-enqueue the jobs persisted by a previous run (reboot recovery). Jobs
 * come back as `queued` — the download archive dedups anything that finished
 * in the meantime and updates are idempotent re-scans. Returns how many jobs
 * were restored, or 0 when there is no state file.
 */
export async function restoreQueueState(
  queue: DownloadQueue = downloadQueue,
  stateFile: string = QUEUE_STATE_FILE,
): Promise<number> {
  let raw: string;
  try {
    raw = await fs.readFile(stateFile, 'utf-8');
  } catch {
    return 0;
  }
  try {
    const state = JSON.parse(raw) as { paused?: unknown; jobs?: unknown };
    if (state.paused === true) {
      queue.setPaused(true);
    }
    const requests = Array.isArray(state.jobs)
      ? state.jobs.map(toEnqueueRequest).filter((request): request is EnqueueRequest => request !== null)
      : [];
    if (requests.length > 0) {
      queue.enqueue(requests);
    }
    return requests.length;
  } catch (error) {
    logger.warn(`Cannot restore queue state: ${error instanceof Error ? error.message : String(error)}`);
    return 0;
  }
}

/**
 * Convert one persisted job back into an enqueue request. Entries that do not
 * look like a job we wrote (corrupt hand-edited file) are skipped.
 */
function toEnqueueRequest(job: unknown): EnqueueRequest | null {
  if (!job || typeof job !== 'object') {
    return null;
  }
  const record = job as Record<string, unknown>;
  const { folderPath, videoId } = record;
  if (typeof folderPath !== 'string' || typeof videoId !== 'string') {
    return null;
  }
  return {
    folderPath,
    videoId,
    videoUrl: typeof record.videoUrl === 'string' ? record.videoUrl : `https://www.youtube.com/watch?v=${videoId}`,
    ...(typeof record.title === 'string' ? { title: record.title } : {}),
    type: record.type === 'update' ? 'update' : 'download',
    ...(typeof record.baseName === 'string' ? { baseName: record.baseName } : {}),
    ...(record.options && typeof record.options === 'object' ? { options: record.options as DownloadOptions } : {}),
  };
}
