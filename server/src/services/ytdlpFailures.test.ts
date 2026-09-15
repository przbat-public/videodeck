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

  it('detects disk-full, geo-block, bot-wall and age-gate errors', () => {
    expect(detectPermanentFailure(['ERROR: unable to write: No space left on device'])?.code).toBe('no-space');
    expect(
      detectPermanentFailure(['ERROR: [youtube] x: Video unavailable. This video is not available in your country'])
        ?.code,
    ).toBe('geo-restricted');
    expect(detectPermanentFailure(["ERROR: [youtube] x: Sign in to confirm you're not a bot"])?.code).toBe('bot-wall');
    expect(detectPermanentFailure(['ERROR: [youtube] x: Sign in to confirm your age'])?.code).toBe('age-gate');
  });

  it('returns undefined for retryable and unrelated lines', () => {
    expect(
      detectPermanentFailure(['[download]  45.2% of 123.45MiB', 'ERROR: HTTP Error 429: Too Many Requests']),
    ).toBeUndefined();
    expect(detectPermanentFailure([])).toBeUndefined();
  });
});
