import { detectPermanentFailure } from './ytdlpFailures';

describe('detectPermanentFailure', () => {
  it('detects members-only videos from the real yt-dlp error line', () => {
    expect(
      detectPermanentFailure([
        "ERROR: [youtube] obNLctxL3_c: This video is available to this channel's members on level: Supporter (or any higher level). Join this channel to get access to members-only content and other exclusive perks.",
      ])?.code,
    ).toBe('members-only');
  });

  it('detects private and removed videos', () => {
    expect(detectPermanentFailure(['ERROR: [youtube] a: This video is private'])?.code).toBe('private');
    expect(detectPermanentFailure(['ERROR: [youtube] a: This video has been removed by the uploader'])?.code).toBe(
      'removed',
    );
    expect(
      detectPermanentFailure([
        'ERROR: [youtube] a: This video is no longer available because the uploader has closed their YouTube account',
      ])?.code,
    ).toBe('removed');
  });

  it('detects the current live yt-dlp wordings (observed with yt-dlp 2026.08)', () => {
    // Dead id, observed live: `yt-dlp --simulate https://www.youtube.com/watch?v=AAAAAAAAAAA`
    expect(detectPermanentFailure(['ERROR: [youtube] AAAAAAAAAAA: This video is unavailable'])?.code).toBe('removed');
    // Current private wording (kept as an alternative to the older one).
    expect(
      detectPermanentFailure(["ERROR: [youtube] a: Private video. Sign in if you've been granted access to this video"])
        ?.code,
    ).toBe('private');
  });

  it('detects disk-full, geo-block, bot-wall and age-gate errors', () => {
    expect(detectPermanentFailure(['ERROR: unable to write: No space left on device'])?.code).toBe('no-space');
    expect(
      detectPermanentFailure(['ERROR: [youtube] x: Video unavailable. This video is not available in your country'])
        ?.code,
    ).toBe('geo-restricted');
    expect(detectPermanentFailure(["ERROR: [youtube] x: Sign in to confirm you're not a bot"])?.code).toBe('bot-wall');
    expect(detectPermanentFailure(['ERROR: [youtube] x: Sign in to confirm your age'])?.code).toBe('age-gate');
  });

  it('detects the geo-block wording yt-dlp 2026.8.19 prints for YouTube', () => {
    // _video.py raises YouTube's own subreason as a GeoRestrictedError
    expect(
      detectPermanentFailure([
        'ERROR: [youtube] x: The uploader has not made this video available in your country',
        'This video is available in Poland.',
        'You might want to use a VPN or a proxy server (with --proxy) to workaround.',
      ])?.code,
    ).toBe('geo-restricted');
  });

  it("detects yt-dlp's generic geo-restriction message", () => {
    expect(
      detectPermanentFailure([
        'ERROR: [youtube] x: This video is not available from your location due to geo restriction',
      ])?.code,
    ).toBe('geo-restricted');
  });

  it('reads only error lines, never a file name or a notice', () => {
    // A title lands in the log through the Destination and Merger lines, and
    // yt-dlp prints its own age notice for a video it can still download.
    // Neither is a failure: the run that printed them may well succeed.
    expect(
      detectPermanentFailure([
        '[download] Destination: 20240101_Why_my_video_got_age-restricted.f137.mp4',
        '[youtube] x: This video is age-restricted; some formats may be missing without authentication.',
        '[Merger] Merging formats into "20240101_ENOSPC_explained.mp4"',
      ]),
    ).toBeUndefined();
  });

  it('takes a video-level reason only from the extractor, not from an error that quotes a file name', () => {
    // A disk error that names the file is not an age gate
    expect(
      detectPermanentFailure([
        "ERROR: unable to open for writing: [Errno 13] Permission denied: '20240101_age-restricted.f137.mp4.part'",
      ]),
    ).toBeUndefined();
    expect(detectPermanentFailure(['ERROR: unable to write: No space left on device'])?.code).toBe('no-space');
  });

  it('returns undefined for retryable and unrelated lines', () => {
    expect(
      detectPermanentFailure(['[download]  45.2% of 123.45MiB', 'ERROR: HTTP Error 429: Too Many Requests']),
    ).toBeUndefined();
    expect(detectPermanentFailure([])).toBeUndefined();
  });
});
