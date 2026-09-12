import { EventEmitter } from 'events';
import { spawn as nodeSpawn } from 'child_process';
import { randomUUID } from 'crypto';
import type { DownloadOptions, JobStatus, JobType, QueueJob } from '@shared/api';
import { refreshIndex } from './folderIndex';
import { DEFAULT_DOWNLOAD_OPTIONS } from './folderConfig';
import { indexVideosFromDisk } from './videoScanner';
import { stripUndefined } from '../utils/objectUtils';

/**
 * Server-side yt-dlp job queue.
 *
 * Jobs live and run independently of HTTP requests: closing a browser tab no
 * longer kills a half-finished download. Concurrency is limited globally and
 * to one running job per folder (yt-dlp appends to archive.txt in the folder).
 *
 * Two job types:
 *  - `download`: full download with `--download-archive archive.txt`, so a
 *    video whose title changed on YouTube is never downloaded twice.
 *  - `update`: metadata-only refresh (`--skip-download`) written under the
 *    *existing* file stem, so info.json / subtitles / thumbnail are overwritten
 *    in place instead of creating a second set of files under a new title.
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
  maxConcurrent?: number;
  logTail?: number;
  /** Keep finished jobs for this long before pruning (ms) */
  retainFinishedMs?: number;
  spawnFn?: SpawnFn;
  /** Called after a job finishes successfully (default: refresh folder index) */
  afterJob?: (job: QueueJob) => Promise<void>;
  ytDlpPath?: string;
}

const OUTPUT_TEMPLATE = '%(upload_date)s_%(title)s.%(ext)s';

/**
 * Format selector: prefer h264/aac in mp4 (plays everywhere), then any
 * best video+audio, then a single best file — all capped at maxHeight.
 */
export function buildFormatSelector(maxHeight: number): string {
  const h = `[height<=${maxHeight}]`;
  return `bestvideo${h}[ext=mp4]+bestaudio[ext=m4a]/bestvideo${h}+bestaudio/best${h}`;
}

function buildMetadataArgs(options: DownloadOptions): string[] {
  const args = ['--write-thumbnail', '--write-description', '--write-info-json'];
  if (options.subLangs.length > 0) {
    args.push('--write-subs', '--write-auto-subs', '--sub-lang', options.subLangs.join(','));
  }
  if (options.writeComments) {
    args.push('--write-comments');
  }
  return args;
}

const PROGRESS_RE = /\[download\]\s+(\d{1,3}(?:\.\d+)?)%/;

/**
 * yt-dlp output templates treat `%` specially; a literal stem must escape it.
 */
export function escapeOutputTemplate(literal: string): string {
  return literal.replace(/%/g, '%%');
}

export function buildYtDlpArgs(
  job: Pick<QueueJob, 'type' | 'videoUrl' | 'baseName' | 'options'>
): string[] {
  const options = job.options ?? DEFAULT_DOWNLOAD_OPTIONS;
  if (job.type === 'update') {
    if (!job.baseName) {
      throw new Error('update job requires baseName');
    }
    return [
      '-i',
      '--newline',
      '--skip-download',
      '-o',
      `${escapeOutputTemplate(job.baseName)}.%(ext)s`,
      ...buildMetadataArgs(options),
      job.videoUrl,
    ];
  }
  return [
    '-c',
    '-i',
    '--newline',
    '-o',
    OUTPUT_TEMPLATE,
    '--restrict-filenames',
    '--download-archive',
    'archive.txt',
    '-f',
    buildFormatSelector(options.maxHeight),
    '--merge-output-format',
    'mp4',
    ...buildMetadataArgs(options),
    job.videoUrl,
  ];
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
  console.log(
    `Job ${job.id}: indexed ${indexed}/${baseNames.length} changed videos in Elasticsearch`
  );
}

export class DownloadQueue extends EventEmitter {
  private readonly jobs = new Map<string, QueueJob>();
  private readonly processes = new Map<string, SpawnedProcess>();
  private readonly maxConcurrent: number;
  private readonly logTail: number;
  private readonly retainFinishedMs: number;
  private readonly spawnFn: SpawnFn;
  private readonly afterJob: (job: QueueJob) => Promise<void>;
  private readonly ytDlpPath: string;

  constructor(options: DownloadQueueOptions = {}) {
    super();
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? 2);
    this.logTail = options.logTail ?? 40;
    this.retainFinishedMs = options.retainFinishedMs ?? 60 * 60 * 1000;
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

  private runningCount(): number {
    let count = 0;
    for (const job of this.jobs.values()) {
      if (job.status === 'running') {
        count += 1;
      }
    }
    return count;
  }

  private folderBusy(folderPath: string): boolean {
    for (const job of this.jobs.values()) {
      if (job.status === 'running' && job.folderPath === folderPath) {
        return true;
      }
    }
    return false;
  }

  private pump(): void {
    while (this.runningCount() < this.maxConcurrent) {
      const next = Array.from(this.jobs.values()).find(
        (job) => job.status === 'queued' && !this.folderBusy(job.folderPath)
      );
      if (!next) {
        return;
      }
      this.start(next);
    }
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

    const onData = (chunk: Buffer | string) => this.appendLog(job, chunk.toString());
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);

    child.on('error', (error) => {
      this.appendLog(job, `spawn error: ${error.message}`);
      if (job.status === 'running') {
        this.finish(job, 'error', error.message, null);
      }
    });

    child.on('close', (code) => {
      this.processes.delete(job.id);
      if (job.status !== 'running') {
        // already cancelled or failed via 'error'
        this.pump();
        return;
      }
      if (code === 0) {
        job.progress = 100;
        void this.afterJob(job)
          .catch((error) => {
            console.error(`downloadQueue: afterJob failed for ${job.videoId}:`, error);
          })
          .finally(() => this.finish(job, 'done', undefined, code));
      } else {
        this.finish(job, 'error', `yt-dlp exited with code ${code}`, code);
      }
    });
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
    this.emitJob(job);
    this.pump();
  }

  private appendLog(job: QueueJob, text: string): void {
    const lines = text.split(/\r\n|\r|\n/).filter((line) => line.trim().length > 0);
    if (lines.length === 0) {
      return;
    }
    for (const line of lines) {
      const percent = PROGRESS_RE.exec(line)?.[1];
      if (percent !== undefined) {
        job.progress = Math.min(100, parseFloat(percent));
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

const concurrencyFromEnv = parseInt(process.env.DOWNLOAD_CONCURRENCY || '', 10);

/** Application-wide queue instance */
export const downloadQueue = new DownloadQueue({
  maxConcurrent:
    Number.isFinite(concurrencyFromEnv) && concurrencyFromEnv > 0 ? concurrencyFromEnv : 2,
});
