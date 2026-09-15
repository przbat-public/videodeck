/**
 * yt-dlp failures that retrying cannot fix. The queue's retry backoff exists
 * for throttling and network hiccups — waiting it out for these errors only
 * wastes minutes per video.
 *
 * Detected from the job log: yt-dlp prints the extractor error before
 * exiting, and (with our `-i`) exits with code 1. The patterns below match
 * the stable fragments of the messages, which YouTube may reword freely.
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
  },
  {
    pattern: /This video is private/i,
    code: 'private',
    description: 'The video is private',
  },
  {
    pattern: /This video has been removed|This video is no longer available|This video isn't available/i,
    code: 'removed',
    description: 'The video has been removed or is no longer available',
  },
  {
    // ENOSPC during download: retrying only fills the disk further while the
    // .part files keep growing.
    pattern: /No space left on device|ENOSPC|error 28|Disk quota exceeded/i,
    code: 'no-space',
    description: 'The download disk is full (no space left on device)',
  },
  {
    // "ERROR: [youtube] xyz: Video unavailable. This video is not available in your country"
    pattern: /not available in your country|is not available in your country/i,
    code: 'geo-restricted',
    description: 'The video is geo-restricted (not available in your country)',
  },
  {
    // YouTube's bot wall: retrying with the same IP/UA never helps.
    pattern: /Sign in to confirm you're not a bot/i,
    code: 'bot-wall',
    description: 'YouTube is asking for a sign-in (bot wall) — retrying will not help',
  },
  {
    // Age-gated videos need a logged-in session; retrying cannot change that.
    pattern: /confirm your age|age-restricted|age restricted/i,
    code: 'age-gate',
    description: 'The video is age-restricted and requires a logged-in session',
  },
];

/** The first permanent failure found in the log, or undefined */
export function detectPermanentFailure(log: readonly string[]): PermanentFailure | undefined {
  for (const line of log) {
    for (const failure of PERMANENT_FAILURES) {
      if (failure.pattern.test(line)) {
        return failure;
      }
    }
  }
  return undefined;
}
