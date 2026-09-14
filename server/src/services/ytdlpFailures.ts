/**
 * yt-dlp failures that retrying cannot fix. The queue's retry backoff (3
 * attempts, 30 s apart) exists for throttling and network hiccups — waiting
 * it out for these errors only wastes minutes per video.
 *
 * Detected from the job log: yt-dlp prints the extractor error before
 * exiting, and (with our `-i`) exits with code 1. The patterns below match
 * the stable fragments of the messages, which YouTube may reword freely.
 */

const PERMANENT_FAILURES: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  {
    // "ERROR: [youtube] obNLctxL3_c: This video is available to this
    // channel's members on level: Supporter (or any higher level). Join
    // this channel to get access to members-only content and other
    // exclusive perks."
    pattern: /available to this channel's members|members-only content/i,
    reason: 'Video jest dostępne tylko dla członków kanału (members-only)',
  },
  {
    pattern: /This video is private/i,
    reason: 'Video jest prywatne',
  },
  {
    pattern:
      /This video has been removed|This video is no longer available|This video isn't available/i,
    reason: 'Video zostało usunięte lub jest niedostępne',
  },
];

/** The reason of the first permanent failure found in the log, or undefined */
export function detectPermanentFailure(log: readonly string[]): string | undefined {
  for (const line of log) {
    for (const { pattern, reason } of PERMANENT_FAILURES) {
      if (pattern.test(line)) {
        return reason;
      }
    }
  }
  return undefined;
}
