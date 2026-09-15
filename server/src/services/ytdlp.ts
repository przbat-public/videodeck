import { spawn } from 'node:child_process';
import type { DownloadOptions, JobType } from '@videodeck/shared/api';
import { DEFAULT_DOWNLOAD_OPTIONS } from './folderConfig';

/**
 * Everything the server says to yt-dlp lives here, behind a small, testable
 * surface: the argument templates the download queue uses, the playlist fetch
 * the folder routes use, and the `spawn` wrapper both share. Other services
 * never hand-build yt-dlp arguments.
 */

export const OUTPUT_TEMPLATE = '%(upload_date)s_%(title)s.%(ext)s';

/**
 * Machine-readable progress line (yt-dlp `--progress-template`). Starts with
 * a literal `download ` marker so shared/progress.ts can parse it
 * unambiguously, but still shows size/speed/ETA in the job log the queue UI
 * displays.
 */
export const PROGRESS_TEMPLATE =
  'download %(progress._percent_str)s (%(progress._total_bytes_str)s @ %(progress._speed_str)s, ETA %(progress._eta_str)s)';

/**
 * Runtime resilience flags shared by downloads and updates:
 *  - `--file-access-retries`: videos land on swappable external drives;
 *    transient file access errors (USB/network hiccups) retry up to 10 times
 *    with an exponential 1..10 s sleep instead of failing the whole job.
 *  - `--progress-delta 1`: at most one progress line per second — the queue
 *    tail-keeps 40 log lines, and a fast link used to flood them.
 *  - `--socket-timeout 30`: a dead network path must not pin a job forever
 *    (the queue watchdog is the second line of defense).
 */
const RUNTIME_ARGS = [
  '--file-access-retries',
  '10',
  '--retry-sleep',
  'file_access:exp=1:10',
  '--progress-delta',
  '1',
  '--socket-timeout',
  '30',
  '--progress-template',
  PROGRESS_TEMPLATE,
];

/**
 * Format selector: prefer h264/aac in mp4 (plays everywhere — YouTube is
 * increasingly serving AV1 in mp4, which Safari and older devices cannot
 * decode), then any mp4 video+audio, then any codec, then a single best
 * file — all capped at maxHeight.
 */
export function buildFormatSelector(maxHeight: number): string {
  const h = `[height<=${maxHeight}]`;
  const h264 = '[vcodec^=avc1]';
  return (
    `bestvideo${h}${h264}[ext=mp4]+bestaudio[ext=m4a]/` +
    `bestvideo${h}[ext=mp4]+bestaudio[ext=m4a]/` +
    `bestvideo${h}+bestaudio/best${h}`
  );
}

/**
 * Metadata flags shared by downloads and updates. `extraArgs` (per-folder
 * config.json) are appended last, just before the URL, so a hand-written
 * option overrides nothing structural: flags the pipeline depends on
 * (`-f`, `-o`, `--download-archive`, `--merge-output-format`, `--paths`) are
 * rejected by `validateFolderConfig` before they ever get here.
 */
function buildMetadataArgs(options: DownloadOptions): string[] {
  const args = ['--write-thumbnail', '--write-description', '--write-info-json'];
  if (options.subLangs.length > 0) {
    args.push('--write-subs', '--write-auto-subs', '--sub-lang', options.subLangs.join(','));
  }
  if (options.writeComments) {
    args.push('--write-comments');
  }
  // Per-folder feature flags (config.json / the status-page editor):
  if (options.concurrentFragments !== undefined && options.concurrentFragments > 1) {
    args.push('-N', String(options.concurrentFragments));
  }
  if (options.sponsorblockRemove) {
    args.push('--sponsorblock-remove', 'sponsor,selfpromo,interaction');
  }
  if (options.impersonate) {
    // The cookie-less answer to YouTube bot walls; also safe for us because
    // it never touches the browser's cookie jar (unlike the forbidden flags).
    args.push('--impersonate', 'chrome');
  }
  if (options.extraArgs) {
    args.push(...options.extraArgs);
  }
  return args;
}

/**
 * yt-dlp output templates treat `%` specially; a literal stem must escape it.
 */
export function escapeOutputTemplate(literal: string): string {
  return literal.replace(/%/g, '%%');
}

/** The pieces of a queue job the argument builder needs */
export interface YtDlpJobSpec {
  type: JobType;
  videoUrl: string;
  baseName?: string | undefined;
  options?: DownloadOptions | undefined;
}

export function buildYtDlpArgs(job: YtDlpJobSpec): string[] {
  const options = job.options ?? DEFAULT_DOWNLOAD_OPTIONS;
  if (job.type === 'update') {
    if (!job.baseName) {
      throw new Error('update job requires baseName');
    }
    return [
      '-i',
      '--no-playlist',
      '--newline',
      ...RUNTIME_ARGS,
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
    '--no-playlist',
    '--newline',
    ...RUNTIME_ARGS,
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

/**
 * Fetch a channel's video list as NDJSON (`yt-dlp --flat-playlist -j`).
 * `-i` turns per-video failures (private/deleted entries) into a successful
 * run: yt-dlp still exits non-zero without it, and the endpoint used to
 * answer 500 even though every remaining video was fetched.
 */
export function buildPlaylistArgs(channelUrl: string): string[] {
  return ['--flat-playlist', '-i', '-j', channelUrl];
}

/** Wall-clock limit for a playlist fetch (huge channels are slow) */
const RUN_TIMEOUT_MS = 10 * 60 * 1000;
/** Stdout cap: bounds memory for pathological channels (NDJSON is tiny per line) */
const MAX_STDOUT_BYTES = 64 * 1024 * 1024;

/**
 * Run yt-dlp to completion, resolving with its stdout or rejecting with a
 * message that includes the stderr tail. No shell is involved (`spawn` takes
 * an argument array), so channel URLs cannot inject commands. A hung yt-dlp
 * is killed after `RUN_TIMEOUT_MS` and the collected stdout is capped at
 * `MAX_STDOUT_BYTES`.
 */
export function runYtDlp(args: string[], cwd: string, options: { command?: string } = {}): Promise<string> {
  const command = options.command ?? process.env.YTDLP_PATH ?? 'yt-dlp';
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let settled = false;
    // Latches the promise: the first terminal event wins (timeout, error or
    // close), everything after it is ignored.
    const settle = (): boolean => {
      if (settled) {
        return false;
      }
      settled = true;
      clearTimeout(timer);
      return true;
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      if (settle()) {
        reject(new Error(`${command} timed out after ${Math.round(RUN_TIMEOUT_MS / 1000)}s`));
      }
    }, RUN_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      if (outBytes < MAX_STDOUT_BYTES) {
        out.push(chunk);
        outBytes += chunk.length;
      }
    });
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', (error) => {
      if (settle()) {
        reject(error);
      }
    });
    child.on('close', (code) => {
      if (code === 0) {
        if (settle()) {
          resolve(Buffer.concat(out).toString('utf-8'));
        }
      } else if (settle()) {
        reject(new Error(`${command} exited with code ${code}: ${Buffer.concat(err).toString('utf-8').trim()}`));
      }
    });
  });
}

/**
 * The installed yt-dlp version (`yt-dlp --version`), trimmed — or null when
 * the binary is missing or broken. Logged at startup: YouTube changes break
 * old yt-dlp releases regularly, so the version belongs in the boot log.
 */
export async function getYtDlpVersion(command = 'yt-dlp'): Promise<string | null> {
  try {
    return (await runYtDlp(['--version'], process.cwd(), { command })).trim();
  } catch {
    return null;
  }
}
