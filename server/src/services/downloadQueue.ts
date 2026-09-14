import { EventEmitter } from 'events';
import { spawn as nodeSpawn } from 'child_process';
import { randomUUID } from 'crypto';
import type { DownloadOptions, JobStatus, JobType, QueueJob } from '@shared/api';
import { refreshIndex } from './folderIndex';
import { indexVideosFromDisk } from './videoScanner';
import { stripUndefined } from '../utils/objectUtils';
import { removePartialDownloads } from '../utils/fsUtils';
import { extractYtDlpProgress } from '@shared/progress';
import { buildYtDlpArgs } from './ytdlp';
import { detectPermanentFailure } from './ytdlpFailures';
import { logger } from '../utils/logger';

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
}

export type SpawnFn = (command: string, args: string[], options: { cwd: string }) => SpawnedProcess;

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
  /** Backoff between attempts (ms, default 30 s) */
  retryDelayMs?: number;
  spawnFn?: SpawnFn;
  /** Called after a job finishes successfully (default: refresh folder index) */
  afterJob?: (job: QueueJob) => Promise<void>;
  ytDlpPath?: string;
}

function isActive(job: QueueJob): boolean {
  return job.status === 'queued' || job.status === 'running';
}

/**
 * Default post-job hook: refresh the folder's `.videos-index.json` and push
 * the videos whose files changed during the job into Elasticsearch, so a
 * download or metadata update is searchable without a full reindex.
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
  const indexed = await indexVideosFromDisk(job.folderPath, baseNames);
  logger.info(
    `Job ${job.id}: indexed ${indexed}/${baseNames.length} changed videos in Elasticsearch`
  );
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
  private readonly spawnFn: SpawnFn;
  private readonly afterJob: (job: QueueJob) => Promise<void>;
  private readonly ytDlpPath: string;
  /** Spawns already used by a job (cleared when it finishes) */
  private readonly attempts = new Map<string, number>();
  /** Pending retry timers, keyed by job id (cleared on cancel) */
  private readonly retryTimers = new Map<string, NodeJS.Timeout>();
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
    this.spawnFn = options.spawnFn ?? nodeSpawn;
    this.afterJob = options.afterJob ?? indexChangedVideos;
    this.ytDlpPath = options.ytDlpPath ?? 'yt-dlp';
  }

  /**
   * Add jobs. A job identical (folder + videoId + type) to one already queued
   * or running is not duplicated — the existing job is returned instead.
   */
  enqueue(requests: EnqueueRequest[]): QueueJob[] {
    const result: QueueJob[] = [];
    for (const request of requests) {
      const existing = this.findActive(request.folderPath, request.videoId, request.type);
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
    this.pump();
    return result.map((job) => this.snapshot(job));
  }

  get(id: string): QueueJob | undefined {
    const job = this.jobs.get(id);
    return job ? this.snapshot(job) : undefined;
  }

  list(folderPath?: string): QueueJob[] {
    this.prune();
    const jobs = Array.from(this.jobs.values()).filter(
      (job) => !folderPath || job.folderPath === folderPath
    );
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
      child?.kill('SIGTERM');
      // 'close' handler will clean up the process map and pump the queue
      return true;
    }
    job.status = 'cancelled';
    job.finishedAt = new Date().toISOString();
    this.emitJob(job);
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

  private findActive(folderPath: string, videoId: string, type: JobType): QueueJob | undefined {
    for (const job of this.jobs.values()) {
      if (
        isActive(job) &&
        job.folderPath === folderPath &&
        job.videoId === videoId &&
        job.type === type
      ) {
        return job;
      }
    }
    return undefined;
  }

  private running(type: JobType): QueueJob[] {
    return Array.from(this.jobs.values()).filter(
      (job) => job.status === 'running' && job.type === type
    );
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
    return (
      downloads.length < this.maxConcurrent &&
      !downloads.some((running) => running.folderPath === job.folderPath)
    );
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
      child = this.spawnFn(this.ytDlpPath, buildYtDlpArgs(job), { cwd: job.folderPath });
    } catch (error) {
      this.finish(job, 'error', error instanceof Error ? error.message : String(error), null);
      return;
    }
    this.processes.set(job.id, child);
    this.attempts.set(job.id, (this.attempts.get(job.id) ?? 0) + 1);

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

    child.on('close', (code) => {
      this.processes.delete(job.id);
      if (job.status !== 'running') {
        // Already cancelled or failed via 'error'. A cancelled download was
        // killed mid-write: sweep the temporary files yt-dlp left behind.
        if (job.status === 'cancelled' && job.type === 'download') {
          void removePartialDownloads(job.folderPath);
        }
        this.pump();
        return;
      }
      if (code === 0) {
        // With -i, yt-dlp exits 0 even for extractor errors (members-only,
        // private, removed) — detect them from the log so such videos are
        // never marked as downloaded.
        const permanent = detectPermanentFailure(job.log);
        if (permanent) {
          this.appendLog(job, permanent);
          this.finish(job, 'error', permanent, code);
          return;
        }
        job.progress = 100;
        void this.runAfterJob(job).then(() => this.finish(job, 'done', undefined, code));
        return;
      }

      // Videos that can never succeed (members-only, private, removed) skip
      // the retry backoff entirely — waiting would only waste time.
      const permanent = detectPermanentFailure(job.log);
      if (permanent) {
        this.appendLog(job, permanent);
        this.finish(job, 'error', permanent, code);
        return;
      }

      // YouTube throttles (429) and transient network failures are common:
      // retry a few times with a backoff before declaring the job failed.
      const attempts = this.attempts.get(job.id) ?? 1;
      if (attempts < this.maxAttempts) {
        const delay = this.retryDelayMs;
        job.progress = 0;
        this.appendLog(
          job,
          `yt-dlp exited with code ${code} — retrying in ${Math.round(delay / 1000)}s (attempt ${attempts}/${this.maxAttempts})`
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
        return;
      }

      this.finish(job, 'error', `yt-dlp exited with code ${code} after ${attempts} attempts`, code);
    });
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
    this.pump();
  }

  private appendLog(job: QueueJob, text: string): void {
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

/** Application-wide queue instance */
export const downloadQueue = new DownloadQueue({
  maxConcurrent: readConcurrency(process.env.DOWNLOAD_CONCURRENCY, 2),
  maxConcurrentUpdates: readConcurrency(process.env.UPDATE_CONCURRENCY, 2),
  maxAttempts: readConcurrency(process.env.DOWNLOAD_MAX_ATTEMPTS, 3),
});
