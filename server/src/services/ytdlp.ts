import { spawn } from 'node:child_process';
import path from 'node:path';
import type { DownloadOptions, JobType } from '@videodeck/shared/api';
import { isTemplateSafeStem } from '../utils/videoStem';
import { assertExtraArgsAllowed, DEFAULT_DOWNLOAD_OPTIONS } from './folderConfig';
import { STAGING_DIR, usesStaging } from './refreshStaging';

/**
 * Everything the server says to yt-dlp lives here, behind a small, testable
 * surface: the argument templates the download queue uses, the playlist fetch
 * the folder routes use, and the `spawn` wrapper both share. Other services
 * never hand-build yt-dlp arguments.
 */

/**
 * How a download names its files. The id ends the name: under
 * --restrict-filenames, titles that differ only in letters outside ASCII, in
 * punctuation or in case (on a case-insensitive drive) sanitize to one name,
 * and a second video of the same day then took over the first one's sidecars.
 * Older files keep their `<upload_date>_<title>` names; updates and repairs
 * reuse whatever stem a video has.
 */
export const OUTPUT_TEMPLATE = '%(upload_date)s_%(title)s_%(id)s.%(ext)s';

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
 * Metadata flags shared by downloads, updates and repairs. `extraArgs`
 * (per-folder config.json) are appended last, just before the URL; anything
 * outside the allowlist in `folderConfig.ts` is refused here, which is the last
 * check before spawn.
 *
 * `writeComments` is a parameter rather than a read of `options` because a
 * repair of the sidecars alone must not pull the comment section again: it is
 * the largest and slowest part of a yt-dlp run on a real channel.
 */
function buildMetadataArgs(options: DownloadOptions, writeComments = options.writeComments): string[] {
  const args = ['--write-thumbnail', '--write-description', '--write-info-json'];
  if (options.subLangs.length > 0) {
    args.push('--write-subs', '--write-auto-subs', '--sub-lang', options.subLangs.join(','));
  }
  if (writeComments) {
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
    // it never touches a cookie jar, and the extraArgs allowlist admits no
    // cookie flag either.
    args.push('--impersonate', 'chrome');
  }
  if (options.extraArgs) {
    // Config validation and resolveExtraArgs already drop these. The queue
    // state file is parsed by hand, so this is the last line before spawn.
    assertExtraArgsAllowed(options.extraArgs);
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
  /** The queue job id: names the staging directory of an update or a comment repair */
  id?: string | undefined;
  type: JobType;
  videoUrl: string;
  baseName?: string | undefined;
  options?: DownloadOptions | undefined;
  /** Repair jobs only: whether this run refreshes the comment section */
  writeComments?: boolean | undefined;
}

/**
 * Where a metadata run writes. An update and a comment repair write into
 * their own staging directory (refreshStaging.ts merges the result into the
 * archive), a sidecar repair writes in place under --no-overwrites.
 */
function metadataOutput(job: YtDlpJobSpec, baseName: string): string {
  const file = `${escapeOutputTemplate(baseName)}.%(ext)s`;
  if (!usesStaging(job)) {
    return file;
  }
  if (job.id === undefined || !/^[\w-]+$/.test(job.id)) {
    throw new Error('refusing yt-dlp output template: a staged run needs a plain job id');
  }
  return `${STAGING_DIR}/${job.id}/${file}`;
}

export function buildYtDlpArgs(job: YtDlpJobSpec): string[] {
  const options = job.options ?? DEFAULT_DOWNLOAD_OPTIONS;
  // Last line before spawn: the stem lands inside a path template that yt-dlp
  // also runs through expandvars, and every caller (index lookup, restored
  // state file, the next one somebody adds) goes through here, so an unusable
  // stem stops at this boundary.
  if (job.baseName !== undefined && !isTemplateSafeStem(job.baseName)) {
    throw new Error('refusing yt-dlp output template: baseName must be a single path segment without $');
  }
  if (job.type === 'update') {
    if (!job.baseName) {
      throw new Error('update job requires baseName');
    }
    return [
      '--ignore-config',
      '-i',
      '--no-playlist',
      '--newline',
      ...RUNTIME_ARGS,
      '--skip-download',
      '-o',
      metadataOutput(job, job.baseName),
      ...buildMetadataArgs(options),
      job.videoUrl,
    ];
  }
  if (job.type === 'repair') {
    if (!job.baseName) {
      throw new Error('repair job requires baseName');
    }
    // No `--download-archive`: the file records videos, not the sidecars a
    // repair went looking for, so consulting it here would skip the very work
    // the job exists to do.
    //
    // A sidecar repair passes --no-overwrites, because yt-dlp's default is
    // destructive for an archive: it rewrites the info.json (a repair asks for
    // no comment section, so the archived comments went with it) and deletes
    // a subtitle or a thumbnail before fetching it again (a 429 under -i then
    // left it gone while the job reported success). With the flag yt-dlp keeps
    // every file already there and writes only what is missing, which is what
    // a repair is for. A comment repair cannot take it: the old info.json
    // would win, and the fresh comment list would be thrown away. It writes
    // into its staging directory instead, and refreshStaging.ts merges the
    // fresh comment list with the archived one.
    return [
      '--ignore-config',
      '-i',
      '--no-playlist',
      '--newline',
      ...RUNTIME_ARGS,
      '--skip-download',
      ...(job.writeComments === true ? [] : ['--no-overwrites']),
      '-o',
      metadataOutput(job, job.baseName),
      ...buildMetadataArgs(options, job.writeComments ?? false),
      job.videoUrl,
    ];
  }
  return [
    '--ignore-config',
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
 *
 * `raise_incomplete_data` keeps `-i` from going too far. Without it,
 * "Incomplete data received" on a continuation page is a warning after three
 * retries: yt-dlp stops paging and exits 0 with the pages it had, and the
 * caller replaced list.json with the newest part of the channel. With it the
 * run fails, and the list on disk stays as it was.
 */
export function buildPlaylistArgs(channelUrl: string): string[] {
  return [
    '--ignore-config',
    '--flat-playlist',
    '-i',
    '-j',
    '--extractor-args',
    'youtube:raise_incomplete_data',
    channelUrl,
  ];
}

/** Wall-clock limit for a playlist fetch (huge channels are slow) */
const RUN_TIMEOUT_MS = 10 * 60 * 1000;
/** Stdout cap: bounds memory for pathological channels (NDJSON is tiny per line) */
const MAX_STDOUT_BYTES = 64 * 1024 * 1024;
/**
 * Stderr cap: a failed run reports the end of its stderr, where yt-dlp prints
 * the ERROR line. A long run writes a warning per fragment or comment page,
 * and the whole of it went into memory and into the logged message.
 */
const MAX_STDERR_BYTES = 64 * 1024;

/** The last `max` bytes of a buffer, copied so the dropped head can be freed */
function keepLastBytes(buffer: Buffer, max: number): Buffer {
  return buffer.length > max ? Buffer.from(buffer.subarray(buffer.length - max)) : buffer;
}

/**
 * The yt-dlp command every spawn runs: `yt-dlp` from PATH when YTDLP_PATH is
 * unset, a bare name as it is (PATH finds it too), and a value with a path
 * separator resolved against the server's working directory. spawn would
 * resolve that one against the child's instead, and the queue starts each job
 * in its channel folder, so a relative value answered the boot check while
 * every job failed with ENOENT. An empty value is passed on as it is: spawn
 * refuses it, so every job fails at its start and the boot warns.
 */
export function resolveYtDlpCommand(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.YTDLP_PATH;
  if (value === undefined) {
    return 'yt-dlp';
  }
  return value.includes(path.sep) ? path.resolve(value) : value;
}

/**
 * Run yt-dlp to completion, resolving with its stdout or rejecting with a
 * message that includes the stderr tail. No shell is involved (`spawn` takes
 * an argument array), so channel URLs cannot inject commands. A hung yt-dlp
 * is killed after `RUN_TIMEOUT_MS` and the collected stdout is capped at
 * `MAX_STDOUT_BYTES`. Without a command it runs the binary YTDLP_PATH names
 * (resolveYtDlpCommand), the one the download queue spawns.
 */
export function runYtDlp(args: string[], cwd: string, options: { command?: string | undefined } = {}): Promise<string> {
  const command = options.command ?? resolveYtDlpCommand();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd });
    const out: Buffer[] = [];
    let errTail: Buffer = Buffer.alloc(0);
    let errCut = false;
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
    child.stderr.on('data', (chunk: Buffer) => {
      const joined = Buffer.concat([errTail, chunk]);
      errCut ||= joined.length > MAX_STDERR_BYTES;
      errTail = keepLastBytes(joined, MAX_STDERR_BYTES);
    });
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
        // A cut tail starts mid-line, maybe mid-character: drop to the next line
        const text = errTail.toString('utf-8');
        const tail = errCut ? text.slice(text.indexOf('\n') + 1) : text;
        reject(new Error(`${command} exited with code ${code}: ${tail.trim()}`));
      }
    });
  });
}

/**
 * The version of the yt-dlp binary the download queue spawns (`--version`,
 * trimmed), or null when that binary is missing or broken. Without a command
 * it asks the one YTDLP_PATH names, falling back to PATH like the queue does,
 * so a typo in YTDLP_PATH shows at boot instead of PATH's version. Logged at
 * startup: YouTube changes break old yt-dlp releases regularly, so the
 * version belongs in the boot log.
 */
export async function getYtDlpVersion(command?: string): Promise<string | null> {
  try {
    return (await runYtDlp(['--version'], process.cwd(), { command })).trim();
  } catch {
    return null;
  }
}
