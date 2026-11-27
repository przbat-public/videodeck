/**
 * yt-dlp failures that retrying cannot fix. The queue's retry backoff exists
 * for throttling and network hiccups — waiting it out for these errors only
 * wastes minutes per video.
 *
 * Detected from the job log, and only from yt-dlp's error lines: report_error
 * prefixes every one with `ERROR:` (and sets exit code 1, even under our
 * `-i`). A file name reaches the log through the Destination and Merger lines,
 * and yt-dlp prints notices for videos it can still download ("This video is
 * age-restricted; some formats may be missing"), so matching any line turned
 * successful runs into failures. A reason about the video itself is read
 * only from the extractor's own line (`ERROR: [youtube] <id>: ...`), so an
 * error that quotes a file name cannot pass for one. The patterns match the
 * stable fragments of the messages, which YouTube may reword freely.
 *
 * The queue stores the machine-readable `code` in `job.error` (the client
 * translates it through its i18n catalogs) and appends the English
 * `description` to the job log for context.
 */

export type PermanentFailureCode =
  | 'members-only'
  | 'private'
  | 'removed'
  | 'no-space'
  | 'geo-restricted'
  | 'bot-wall'
  | 'age-gate';

interface PermanentFailure {
  pattern: RegExp;
  code: PermanentFailureCode;
  description: string;
  /** `video`: a reason about the video, read only from the extractor's error line */
  scope: 'video' | 'any';
}

const PERMANENT_FAILURES: readonly PermanentFailure[] = [
  {
    // "ERROR: [youtube] obNLctxL3_c: This video is available to this
    // channel's members on level: Supporter (or any higher level). Join
    // this channel to get access to members-only content and other
    // exclusive perks."
    pattern: /available to this channel's members|members-only content/i,
    code: 'members-only',
    description: 'Members-only video: joining the channel is required, downloading cannot succeed',
    scope: 'video',
  },
  {
    // Live yt-dlp (2026.08) wording: "ERROR: [youtube] id: Private video.
    // Sign in if you've been granted access to this video". The older
    // "This video is private" phrasing stays covered.
    pattern: /This video is private|Private video\. Sign in/i,
    code: 'private',
    description: 'The video is private',
    scope: 'video',
  },
  {
    // Observed live for dead ids: "This video is unavailable". Older
    // removed-by-uploader and closed-account wordings stay covered.
    pattern:
      /This video has been removed|This video is no longer available|This video isn't available|This video is unavailable/i,
    code: 'removed',
    description: 'The video has been removed or is no longer available',
    scope: 'video',
  },
  {
    // ENOSPC during download: retrying only fills the disk further while the
    // .part files keep growing.
    pattern: /No space left on device|ENOSPC|error 28|Disk quota exceeded/i,
    code: 'no-space',
    description: 'The download disk is full (no space left on device)',
    scope: 'any',
  },
  {
    // yt-dlp 2026.8.19 raises YouTube's own subreason: "ERROR: [youtube] xyz:
    // The uploader has not made this video available in your country", then
    // a VPN hint. The older "Video unavailable. This video is not available in
    // your country" stays covered, and yt-dlp's generic geo message ("not
    // available from your location due to geo restriction") is newly covered.
    pattern:
      /not available in your country|has not made this video available in your country|not available from your location/i,
    code: 'geo-restricted',
    description: 'The video is geo-restricted (not available in your country)',
    scope: 'video',
  },
  {
    // YouTube's bot wall: retrying with the same IP/UA never helps.
    pattern: /Sign in to confirm you're not a bot/i,
    code: 'bot-wall',
    description: 'YouTube is asking for a sign-in (bot wall) — retrying will not help',
    scope: 'video',
  },
  {
    // Age-gated videos need a logged-in session; retrying cannot change that.
    pattern: /confirm your age|age-restricted|age restricted/i,
    code: 'age-gate',
    description: 'The video is age-restricted and requires a logged-in session',
    scope: 'video',
  },
];

/** `ERROR: [youtube] <id>: ...`: an error the extractor raised about the video */
const EXTRACTOR_ERROR = /^ERROR: \[[\w:-]+\]/;

/** The first permanent failure found in the log's error lines, or undefined */
export function detectPermanentFailure(log: readonly string[]): PermanentFailure | undefined {
  for (const line of log) {
    if (!line.startsWith('ERROR:')) {
      continue;
    }
    const fromExtractor = EXTRACTOR_ERROR.test(line);
    const failure = PERMANENT_FAILURES.find(
      (candidate) => (candidate.scope === 'any' || fromExtractor) && candidate.pattern.test(line),
    );
    if (failure) {
      return failure;
    }
  }
  return undefined;
}
