import { detectPermanentFailure } from './ytdlpFailures';

describe('detectPermanentFailure', () => {
  it('detects members-only videos from the real yt-dlp error line', () => {
    expect(
      detectPermanentFailure([
        "ERROR: [youtube] obNLctxL3_c: This video is available to this channel's members on level: Supporter (or any higher level). Join this channel to get access to members-only content and other exclusive perks.",
      ])
    ).toBe('Video jest dostępne tylko dla członków kanału (members-only)');
  });

  it('detects private and removed videos', () => {
    expect(detectPermanentFailure(['ERROR: [youtube] a: This video is private'])).toBe(
      'Video jest prywatne'
    );
    expect(
      detectPermanentFailure(['ERROR: [youtube] a: This video has been removed by the uploader'])
    ).toBe('Video zostało usunięte lub jest niedostępne');
    expect(
      detectPermanentFailure([
        'ERROR: [youtube] a: This video is no longer available because the uploader has closed their YouTube account',
      ])
    ).toBe('Video zostało usunięte lub jest niedostępne');
  });

  it('returns undefined for retryable and unrelated lines', () => {
    expect(
      detectPermanentFailure([
        '[download]  45.2% of 123.45MiB',
        'ERROR: HTTP Error 429: Too Many Requests',
      ])
    ).toBeUndefined();
    expect(detectPermanentFailure([])).toBeUndefined();
  });
});
